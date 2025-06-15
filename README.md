# Vertical Trigger System

An interactive web art project that responds to device orientation changes, triggering various digital and physical outputs.

## Features

- Detects when users lift their phone from horizontal to vertical position
- Triggers random outputs including:
  - Physical light control
  - Stepper motor activation
  - Phone vibration
  - Audio playback
  - Global counter updates
  - Cross-device triggers
- Rate-limited to prevent spam (1 trigger per 3 seconds)
- Minimalist visual design
- Real-time WebSocket communication
- Raspberry Pi integration for physical outputs

## Tech Stack

- Frontend: Next.js 14 with TypeScript and Tailwind CSS
- Backend: Node.js with Socket.io
- Hardware: Raspberry Pi 4 with GPIO control

## Setup

### Frontend

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env.local` file:
   ```
   NEXT_PUBLIC_SOCKET_URL=http://localhost:3001
   ```

3. Run the development server:
   ```bash
   npm run dev
   ```

### Backend

1. Navigate to the server directory:
   ```bash
   cd server
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file:
   ```
   PORT=3001
   CLIENT_URL=http://localhost:3000
   ```

4. Start the server:
   ```bash
   npm run dev
   ```

### Raspberry Pi Setup

1. Install required packages:
   ```bash
   sudo apt-get update
   sudo apt-get install python3-pip
   pip3 install RPi.GPIO
   ```

2. Connect hardware:
   - LED to GPIO 17
   - Stepper motor to GPIO pins 18, 23, 24, 25

3. Run the controller:
   ```bash
   python3 controller.py
   ```

## Development

The project uses mock implementations for GPIO control during development. When deploying to a Raspberry Pi, replace the `MockGPIO` class with the actual RPi.GPIO implementation.

## License

MIT
