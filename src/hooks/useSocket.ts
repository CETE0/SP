import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

interface SocketAction {
  type: string;
  description: string;
  pattern?: number[];
  message?: string;
  duration?: number;
  count?: number;
  duelId?: string;
  role?: string;
  result?: string;
}

export const useSocket = () => {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastAction, setLastAction] = useState<SocketAction | null>(null);
  const [globalCounter, setGlobalCounter] = useState(0);
  const [erectionCounter, setErectionCounter] = useState(0);
  const [userCount, setUserCount] = useState(0);
  const [isBanned, setIsBanned] = useState(false);
  const [banMessage, setBanMessage] = useState('');

  useEffect(() => {
    // Connect to server - use ngrok URL for mobile testing
    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || 'https://0e72-190-20-196-13.ngrok-free.app';
    console.log('🔌 SOCKET: Connecting to:', serverUrl);
    socketRef.current = io(serverUrl);

    socketRef.current.on('connect', () => {
      console.log('Connected to server');
      setIsConnected(true);
      setIsBanned(false);
    });

    socketRef.current.on('disconnect', () => {
      console.log('Disconnected from server');
      setIsConnected(false);
    });

    socketRef.current.on('banned', (data: { message: string; unbanTime: number }) => {
      console.log('User banned:', data);
      setIsBanned(true);
      setBanMessage(data.message);
    });

    socketRef.current.on('action', (action: SocketAction) => {
      console.log('Received action:', action);
      setLastAction(action);
      
      // Handle client-side actions
      switch (action.type) {
        case 'morseAudio':
          console.log('Morse audio triggered - will be handled in component');
          break;
          
        default:
          console.log('Unknown action type:', action.type);
          break;
      }
    });

    socketRef.current.on('globalCounter', (counter: number) => {
      console.log('Global counter updated:', counter);
      setGlobalCounter(counter);
    });

    socketRef.current.on('erectionCounter', (counter: number) => {
      console.log('Erection counter updated:', counter);
      setErectionCounter(counter);
    });

    socketRef.current.on('userCount', (count: number) => {
      console.log('User count updated:', count);
      setUserCount(count);
    });

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []);

  const emitTrigger = () => {
    if (socketRef.current && isConnected && !isBanned) {
      console.log('🚀 SOCKET: Emitting trigger event');
      socketRef.current.emit('trigger');
    } else {
      console.log('❌ SOCKET: Cannot emit trigger - socket:', !!socketRef.current, 'connected:', isConnected, 'banned:', isBanned);
    }
  };

  const emitArmed = () => {
    if (socketRef.current && isConnected && !isBanned) {
      socketRef.current.emit('armed');
    }
  };

  return {
    socket: socketRef.current,
    isConnected,
    lastAction,
    globalCounter,
    erectionCounter,
    userCount,
    isBanned,
    banMessage,
    emitTrigger,
    emitArmed
  };
}; 