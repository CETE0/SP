#!/usr/bin/env python3
"""Raspberry Pi Socket.IO hardware client

Features
--------
1. Connects to the backend Socket.IO server (URL provided via SERVER_URL env).
2. Listens for `globalCounter` events and keeps the latest armed-state total.
3. Displays the count on a Waveshare 2.13-inch e-Paper HAT.
4. Blinks an RGB LED (common-cathode/anode 4-pin) in Morse code matching that count.

Install deps on the Pi:
    sudo apt update && sudo apt install -y python3-pip
    sudo pip3 install pillow python-socketio RPi.GPIO
    # Waveshare library (ships as git repo)
    git clone https://github.com/waveshare/epaper.git ~/epaper && \
        sudo python3 ~/epaper/RaspberryPi_JetsonNano/python/install.py

Wiring:
    • E-Paper HAT plugs onto the 40-pin header (SPI pins).
    • RGB LED: configure BCM pin numbers below (defaults: RED=22, GREEN=27, BLUE=17).

Systemd:
    follow README / guide to create /etc/systemd/system/picaron.service that runs this file.
"""

import os
import sys
import time
import threading
from typing import Dict, List

import socketio  # python-socketio client

try:
    import RPi.GPIO as GPIO  # type: ignore
except RuntimeError:
    print("Error: RPi.GPIO must be run as root. Try with sudo.")
    sys.exit(1)

try:
    from waveshare_epd import epd2in13_V2  # type: ignore
except ImportError:
    print(
        "Waveshare e-Paper library not found.\n"
        "Install with: git clone https://github.com/waveshare/e-Paper && sudo python3 e-Paper/RaspberryPi_JetsonNano/python/install.py"
    )
    sys.exit(1)

from PIL import Image, ImageDraw, ImageFont

# ----------------------------- Configuration ----------------------------- #
SERVER_URL = os.getenv("SERVER_URL")
if not SERVER_URL:
    print("Environment variable SERVER_URL is required, e.g. https://sp-production-b59c.up.railway.app")
    sys.exit(1)

# Set to True if an RGB LED is connected and you want Morse blinking.
ENABLE_LED = False  # <<<<<<<<<<  change to True to re-enable LED support

# RGB LED pins (BCM numbering)
LED_PINS: Dict[str, int] = {
    "red": 22,
    "green": 27,
    "blue": 17,
}
PWM_FREQUENCY = 100  # Hz

# Morse timing (seconds)
UNIT = 0.25  # base time unit for dot
DOT = UNIT
DASH = 3 * UNIT
GAP_SYMBOL = UNIT  # between elements of the same character
GAP_LETTER = 3 * UNIT
GAP_WORD = 7 * UNIT

# Fonts for e-paper (change path if custom font installed)
FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_SIZE = 48

# QR code path (must be 118x118 mono PNG placed in raspberry/)
QR_PATH = os.path.join(os.path.dirname(__file__), "qrcode_118x118.png")
# Keyhole icon (24x24) path
KEYHOLE_PATH = os.path.join(os.path.dirname(__file__), "24.png")

# ------------------------------------------------------------------------- #

# Morse code map for digits 0-9
MORSE_DIGITS: Dict[str, str] = {
    "0": "-----",
    "1": ".----",
    "2": "..---",
    "3": "...--",
    "4": "....-",
    "5": ".....",
    "6": "-....",
    "7": "--...",
    "8": "---..",
    "9": "----.",
}


class EPaperDisplay:
    """Handles Waveshare e-Paper drawing."""

    def __init__(self):
        self.epd = epd2in13_V2.EPD()
        # Use FULL_UPDATE mode during initialisation (required by newer API)
        try:
            self.epd.init(self.epd.FULL_UPDATE)
        except TypeError:
            # Fallback for older driver signature with no parameters
            self.epd.init()
        self.width, self.height = self.epd.height, self.epd.width  # note orientation swap
        self.font = ImageFont.truetype(FONT_PATH, FONT_SIZE)

    def _draw_tally_group(self, draw, x, y, h, w_gap, s_gap):
        # draw 4 vertical lines
        for i in range(4):
            x_i = x + i * s_gap
            draw.line((x_i, y, x_i, y + h), fill=0, width=2)
        # diagonal slash
        draw.line((x, y, x + 3 * s_gap, y + h), fill=0, width=2)
        return x + 4 * s_gap + w_gap  # new x cursor

    def _draw_single_stroke(self, draw, x, y, h, s_gap):
        draw.line((x, y, x, y + h), fill=0, width=2)
        return x + s_gap

    def display_tally(self, number: int):
        """Render tally marks representing `number`, rotated 90° for portrait."""
        print(f"[EPD] Displaying tally for: {number}")

        H_STROKE = 40  # height of each stroke before rotation
        S_GAP = 6      # gap between strokes within a group
        G_GAP = 10     # additional gap after a full group of 5
        ROW_GAP = 8    # vertical gap between rows

        # Start with an image in landscape (will rotate later)
        img_land = Image.new("1", (self.height, self.width), 255)  # width/height swapped
        draw = ImageDraw.Draw(img_land)

        x, y = 0, 0
        remaining = number

        while remaining > 0 and y + H_STROKE < img_land.height:
            # Decide group type
            if remaining >= 5:
                # Draw 5-stroke tally group
                # 4 vertical strokes
                for i in range(4):
                    x_i = x + i * S_GAP
                    draw.line((x_i, y, x_i, y + H_STROKE), fill=0, width=2)
                # diagonal across them
                draw.line((x, y, x + 3 * S_GAP, y + H_STROKE), fill=0, width=2)
                x += 4 * S_GAP + G_GAP
                remaining -= 5
            else:
                # Draw single vertical stroke(s)
                for _ in range(remaining):
                    draw.line((x, y, x, y + H_STROKE), fill=0, width=2)
                    x += S_GAP
                remaining = 0

            # Wrap to new row if hitting right edge
            if x + 4 * S_GAP > img_land.width:
                x = 0
                y += H_STROKE + ROW_GAP

        # Rotate 90° to make strokes vertical relative to display orientation
        img_rot = img_land.rotate(90, expand=True)
        self.epd.display(self.epd.getbuffer(img_rot))

    def clear(self):
        self.epd.Clear(0xFF)

    # ------------------ New Counter + QR Layout ------------------ #
    def display_counter_and_qr(self, number: int):
        """Show numeric counter on top half and QR code on bottom half."""
        H = self.epd.height  # 250
        W = self.epd.width   # 122
        img = Image.new("1", (W, H), 255)
        draw = ImageDraw.Draw(img)

        # --- Top half: labels + icon + counter ---
        top_h = H // 2

        # Fonts
        small_font = ImageFont.truetype(FONT_PATH, 14)
        big_font = ImageFont.truetype(FONT_PATH, 32)

        # Prepare measurements for all three lines to center vertically
        l1_text = "HAN SIDO"
        l3_text = "LEVANTADAS"

        l1_w, l1_h = draw.textsize(l1_text, font=small_font)
        l3_w, l3_h = draw.textsize(l3_text, font=small_font)

        num_text = str(number)
        num_w, num_h = draw.textsize(num_text, font=big_font)

        try:
            icon = Image.open(KEYHOLE_PATH).convert("1")
        except FileNotFoundError:
            icon = None
        icon_w = icon.width if icon else 0
        icon_h = icon.height if icon else 0
        gap = 4 if icon else 0

        row_w = num_w + gap + icon_w  # number first, then icon
        row_h = max(num_h, icon_h)

        # vertical spacing between lines
        line_gap = 4

        total_h = l1_h + line_gap + row_h + line_gap + l3_h
        y_cursor = (top_h - total_h) // 2  # center vertically within top half

        # Line 1
        l1_x = (W - l1_w) // 2
        draw.text((l1_x, y_cursor), l1_text, font=small_font, fill=0)
        y_cursor += l1_h + line_gap

        # Line 2 (number + icon)
        row_x = (W - row_w) // 2
        # Draw number
        draw.text((row_x, y_cursor), num_text, font=big_font, fill=0)
        # Paste icon to the right of number
        if icon:
            icon_x = row_x + num_w + gap
            icon_y = y_cursor + max(0, (num_h - icon_h) // 2)
            img.paste(icon, (icon_x, icon_y))
        y_cursor += row_h + line_gap

        # Line 3
        l3_x = (W - l3_w) // 2
        draw.text((l3_x, y_cursor), l3_text, font=small_font, fill=0)

        # --- Bottom half: QR code ---
        try:
            qr = Image.open(QR_PATH).convert("1")
        except FileNotFoundError:
            print(f"[EPD] QR image not found at {QR_PATH}")
            qr = None
        if qr:
            qr_w, qr_h = qr.size
            # Resize if larger than available space
            max_qr_dim = min(W, H - top_h)
            if qr_w > max_qr_dim or qr_h > max_qr_dim:
                qr = qr.resize((max_qr_dim, max_qr_dim), Image.NEAREST)
                qr_w, qr_h = qr.size
            qr_x = (W - qr_w) // 2
            qr_y = top_h + (H - top_h - qr_h) // 2
            img.paste(qr, (qr_x, qr_y))

            # Rotate 180° so content appears upright when device is mounted inverted
            img_rot = img.rotate(180, expand=True)
            self.epd.display(self.epd.getbuffer(img_rot))


class RGBLed:
    """Drives a common-cathode/anode RGB LED via PWM to create pulses."""

    def __init__(self, pins: Dict[str, int]):
        GPIO.setmode(GPIO.BCM)
        self.pwm_channels: Dict[str, GPIO.PWM] = {}
        for color, pin in pins.items():
            GPIO.setup(pin, GPIO.OUT)
            pwm = GPIO.PWM(pin, PWM_FREQUENCY)
            pwm.start(0)  # start off
            self.pwm_channels[color] = pwm
        self._lock = threading.Lock()

    def set_color(self, r: int, g: int, b: int):
        """Set LED color with 0-100 brightness values."""
        with self._lock:
            self.pwm_channels["red"].ChangeDutyCycle(r)
            self.pwm_channels["green"].ChangeDutyCycle(g)
            self.pwm_channels["blue"].ChangeDutyCycle(b)

    def off(self):
        self.set_color(0, 0, 0)

    def cleanup(self):
        self.off()
        for pwm in self.pwm_channels.values():
            pwm.stop()
        GPIO.cleanup()


class MorseBlinker(threading.Thread):
    """Background thread that blinks the LED according to the current number."""

    def __init__(self, led: RGBLed, initial_number: int = 0):
        super().__init__(daemon=True)
        self.led = led
        self.number = initial_number
        self._stop_event = threading.Event()
        self._update_event = threading.Event()

    def update_number(self, new_number: int):
        self.number = new_number
        self._update_event.set()

    def run(self):
        while not self._stop_event.is_set():
            if self.number is None:
                time.sleep(1)
                continue
            sequence = self._number_to_morse_sequence(self.number)
            for element in sequence:
                if self._stop_event.is_set() or self._update_event.is_set():
                    break  # break inner loop to restart with new number
                if element == ".":
                    self._blink(DOT)
                elif element == "-":
                    self._blink(DASH)
                elif element == " ":
                    time.sleep(GAP_LETTER)
                elif element == "/":
                    time.sleep(GAP_WORD)
            self._update_event.clear()
            # After finishing a full sequence, pause before repeating
            time.sleep(GAP_WORD)

    def _blink(self, duration: float):
        self.led.set_color(0, 0, 100)  # blue full brightness
        time.sleep(duration)
        self.led.off()
        time.sleep(GAP_SYMBOL)

    @staticmethod
    def _number_to_morse_sequence(number: int) -> List[str]:
        """Convert number to a flat list of symbols for blinking.

        We separate digits with a space character, and terminate the full
        number with a '/' (word gap) so the pattern repeats cleanly.
        """
        digits = list(str(number))
        symbols: List[str] = []
        for i, d in enumerate(digits):
            symbols.extend(list(MORSE_DIGITS.get(d, "")))
            if i < len(digits) - 1:
                symbols.append(" ")  # gap between digits
        symbols.append("/")  # gap before repeating
        return symbols

    def stop(self):
        self._stop_event.set()
        self.join()


# --------------------------- Main application --------------------------- #

def main():
    display = EPaperDisplay()
    led = RGBLed(LED_PINS) if ENABLE_LED else None
    blinker = MorseBlinker(led) if ENABLE_LED else None
    if ENABLE_LED:
        blinker.start()

    sio = socketio.Client()  # defaults to websocket + polling transports

    @sio.event
    def connect():
        print("[Socket] Connected to", SERVER_URL)

    @sio.event
    def disconnect():
        print("[Socket] Disconnected")

    @sio.on("globalCounter")
    def on_global_counter(count):
        try:
            count_int = int(count)
        except (ValueError, TypeError):
            print("[Socket] Received invalid counter value:", count)
            return
        print(f"[Socket] Global counter updated: {count_int}")
        display.display_counter_and_qr(count_int)
        if ENABLE_LED:
            blinker.update_number(count_int)

    try:
        sio.connect(SERVER_URL, transports=["websocket"])
        sio.wait()  # block forever, ctrl+c to exit
    except KeyboardInterrupt:
        print("Interrupted by user, shutting down…")
    finally:
        if ENABLE_LED and blinker:
            blinker.stop()
        if ENABLE_LED and led:
            led.cleanup()
        display.clear()


if __name__ == "__main__":
    main() 