import time
import json
import socket
import threading
from queue import Queue

# Mock GPIO implementation for development
class MockGPIO:
    def __init__(self):
        self.pins = {}
        self.stepper_position = 0
    
    def setup(self, pin, mode):
        self.pins[pin] = mode
    
    def output(self, pin, value):
        self.pins[pin] = value
    
    def cleanup(self):
        self.pins.clear()

# Configuration
LIGHT_PIN = 17
STEPPER_PINS = [18, 23, 24, 25]  # IN1, IN2, IN3, IN4
STEPS_PER_REVOLUTION = 2048
STEP_DELAY = 0.001

class Controller:
    def __init__(self):
        # Use mock GPIO for development
        self.gpio = MockGPIO()
        self.setup_gpio()
        self.action_queue = Queue()
        self.running = True
        
        # Start action processing thread
        self.processor = threading.Thread(target=self.process_actions)
        self.processor.start()
    
    def setup_gpio(self):
        # Setup light pin
        self.gpio.setup(LIGHT_PIN, 'OUT')
        self.gpio.output(LIGHT_PIN, False)
        
        # Setup stepper pins
        for pin in STEPPER_PINS:
            self.gpio.setup(pin, 'OUT')
            self.gpio.output(pin, False)
    
    def process_actions(self):
        while self.running:
            try:
                action = self.action_queue.get(timeout=1)
                self.execute_action(action)
            except Queue.Empty:
                continue
    
    def execute_action(self, action):
        action_type = action.get('type')
        
        if action_type == 'toggleLight':
            self.toggle_light()
        elif action_type == 'activateStepper':
            self.activate_stepper()
    
    def toggle_light(self):
        current_state = self.gpio.pins.get(LIGHT_PIN, False)
        self.gpio.output(LIGHT_PIN, not current_state)
        print(f"Light {'turned on' if not current_state else 'turned off'}")
    
    def activate_stepper(self):
        # Rotate 180 degrees
        steps = STEPS_PER_REVOLUTION // 2
        direction = 1 if self.gpio.stepper_position < STEPS_PER_REVOLUTION // 2 else -1
        
        for _ in range(steps):
            self.gpio.stepper_position = (self.gpio.stepper_position + direction) % STEPS_PER_REVOLUTION
            self._step_sequence()
            time.sleep(STEP_DELAY)
        
        print("Stepper motor completed rotation")
    
    def _step_sequence(self):
        # Simple full-step sequence
        sequence = [
            [1, 0, 0, 0],
            [0, 1, 0, 0],
            [0, 0, 1, 0],
            [0, 0, 0, 1]
        ]
        
        step = self.gpio.stepper_position % 4
        for pin, value in zip(STEPPER_PINS, sequence[step]):
            self.gpio.output(pin, value)
    
    def cleanup(self):
        self.running = False
        self.processor.join()
        self.gpio.cleanup()

if __name__ == '__main__':
    controller = Controller()
    try:
        # Keep the script running
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        controller.cleanup() 