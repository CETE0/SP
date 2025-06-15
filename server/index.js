import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Global counters
let globalArmedCounter = 0;
let globalErectionCounter = 0;
let connectedUsers = 0;
let bannedUsers = new Map(); // userId -> unban timestamp

// Simplified output - only morse.mp3 audio file
const outputs = [
  { type: 'morseAudio', probability: 1.0, description: 'Play morse.mp3 audio file' }
];

function selectRandomOutput() {
  // Always return morse audio since it's the only option
  return outputs[0];
}

io.on('connection', (socket) => {
  connectedUsers++;
  console.log(`User connected. Total users: ${connectedUsers}`);
  
  // Check if user is banned
  const userId = socket.id;
  if (bannedUsers.has(userId) && Date.now() < bannedUsers.get(userId)) {
    socket.emit('banned', { 
      message: 'You are temporarily banned from the site',
      unbanTime: bannedUsers.get(userId)
    });
    socket.disconnect();
    return;
  } else if (bannedUsers.has(userId)) {
    bannedUsers.delete(userId); // Remove expired ban
  }
  
  // Send current counters to new user
  socket.emit('globalCounter', globalArmedCounter);
  socket.emit('erectionCounter', globalErectionCounter);
  
  // Broadcast updated user count
  io.emit('userCount', connectedUsers);

  socket.on('trigger', () => {
    console.log('Trigger received from user');
    
    const selectedOutput = selectRandomOutput();
    console.log(`Selected output: ${selectedOutput.type} - ${selectedOutput.description}`);
    
    // Only morse audio output
    socket.emit('action', { 
      type: 'morseAudio', 
      description: 'Playing morse.mp3 audio file'
    });
  });

  // Handle global armed counter updates
  socket.on('armed', () => {
    globalArmedCounter++;
    console.log(`Global armed counter: ${globalArmedCounter}`);
    
    // Broadcast updated counter to all users
    io.emit('globalCounter', globalArmedCounter);
  });

  socket.on('disconnect', () => {
    connectedUsers--;
    console.log(`User disconnected. Total users: ${connectedUsers}`);
    
    // Broadcast updated user count
    io.emit('userCount', connectedUsers);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Global armed counter initialized: ${globalArmedCounter}`);
}); 