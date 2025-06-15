import { useEffect, useState, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { useSocket } from '@/hooks/useSocket';

const RATE_LIMIT_MS = 3000;
const SMOOTHING_WINDOW = 5;
const HORIZONTAL_ARMED = 5;  // degrees
const HORIZONTAL_UNARMED = 8; // degrees – hysteresis
const SAMPLE_COUNT_BASELINE = 10;
const SHOW_DEBUG = false;

function smoothBeta(values: number[], windowSize: number = SMOOTHING_WINDOW): number {
  if (values.length === 0) return 0;
  const window = values.slice(-windowSize);
  return window.reduce((sum, val) => sum + val, 0) / window.length;
}

// Enhanced color system for orientation guidance
function getOrientationColors(currentBeta: number, baseBeta: number) {
  if (baseBeta === null || currentBeta === null) {
    return {
      background: '#000000',
      ambient: 'rgba(255, 64, 64, 0.2)',
      primary: '#ff4040',
      intensity: 0.4
    };
  }

  // Calculate progress toward horizontal (0 degrees)
  const betaDelta = currentBeta - baseBeta;
  
  // Only react to negative beta values (tilting forward/down toward horizontal)
  if (betaDelta >= 0) {
    // Vertical/starting position - breathing red
    return {
      background: '#1a0000',
      ambient: 'rgba(255, 64, 64, 0.3)',
      primary: '#ff4040',
      intensity: 0.7
    };
  }

  // Calculate tilt progress toward horizontal
  const totalTiltNeeded = Math.abs(baseBeta - 0); // Distance to horizontal
  const currentTiltProgress = Math.abs(baseBeta - currentBeta); // How much tilted
  const progress = Math.min(currentTiltProgress / totalTiltNeeded, 1); // 0 to 1

  if (Math.abs(currentBeta) <= HORIZONTAL_ARMED) {
    // ARMED state - vibrant success green
    return {
      background: '#001a00',
      ambient: 'rgba(0, 255, 100, 0.5)',
      primary: '#00ff64',
      intensity: 1
    };
  } else {
    // In transition - gradient from red to green
    const r = Math.floor(255 * (1 - progress));
    const g = Math.floor(255 * progress);
    const b = Math.floor(64 * (1 - progress));
    
    return {
      background: `rgb(${Math.floor(r * 0.15)}, ${Math.floor(g * 0.15)}, ${Math.floor(b * 0.1)})`,
      ambient: `rgba(${r}, ${g}, ${b}, ${0.3 + progress * 0.3})`,
      primary: `rgb(${r}, ${g}, ${b})`,
      intensity: 0.5 + (progress * 0.5)
    };
  }
}

export const VerticalDetector = () => {
  const [needsPermission, setNeedsPermission] = useState(false);
  const [permissionRequested, setPermissionRequested] = useState(false);
  const [debug, setDebug] = useState<string>("");
  const [isArmed, setIsArmed] = useState(false);
  const [baseBeta, setBaseBeta] = useState<number | null>(null);
  const [armedCounter, setArmedCounter] = useState(0);

  const [isArmedPulsing, setIsArmedPulsing] = useState(false);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);

  // Destructure only the values we actually use from the socket hook
  const {
    emitTrigger,
    emitArmed,
    globalCounter,
    erectionCounter,
    userCount,
    isConnected,
    isBanned,
    banMessage,
    lastAction
  } = useSocket();
  
  // Helper function to add debug logs (memoised)
  const addDebugLog = useCallback((msg: string) => {
    setDebugLogs(prev => [...prev.slice(-4), msg]);
  }, []);

  // Simple audio play function (replicating tick.mp3 logic)
  const playMorseAudio = () => {
    if (isClient && morseAudio.current) {
      addDebugLog('AUDIO: Playing morse.mp3');
      morseAudio.current.currentTime = 0;
      morseAudio.current.play().catch((error: unknown) => {
        addDebugLog(`AUDIO: Failed - ${error}`);
      });
    } else {
      addDebugLog('AUDIO: Element not ready');
    }
  };

  // NEW: helper to stop audio cleanly
  const stopMorseAudio = () => {
    if (isClient && morseAudio.current && !morseAudio.current.paused) {
      morseAudio.current.pause();
      morseAudio.current.currentTime = 0;
      addDebugLog('AUDIO: Stopped');
    }
  };
  
  // Debug log for connection status changes (only once)
  const hasLoggedConnection = useRef(false);
  useEffect(() => {
    if (!hasLoggedConnection.current) {
      console.log(`SOCKET: ${isConnected ? 'Connected' : 'Client-side mode active'}`);
      hasLoggedConnection.current = true;
    }
  }, [isConnected]);
  const betaHistory = useRef<number[]>([]);
  const gammaHistory = useRef<number[]>([]);
  const lastTrigger = useRef(0);
  const currentOrientation = useRef({ alpha: 0, beta: 0, gamma: 0 });
  const isArmedRef = useRef(false);
  
  // iOS detection and audio setup - client-side only
  const [isIOS, setIsIOS] = useState(false);
  const [isClient, setIsClient] = useState(false);
  const morseAudio = useRef<HTMLAudioElement | null>(null);

  const [motionGranted, setMotionGranted] = useState(false);

  useEffect(() => {
    // Set client-side flag and detect iOS
    setIsClient(true);
    setIsIOS(/iPad|iPhone|iPod/.test(navigator.userAgent));
    console.log('INIT: Component loaded, client-side ready');
  }, []);
  
  // Audio setup (replicating tick.mp3 approach)
  useEffect(() => {
    if (isClient) {
      console.log('AUDIO: Element ready');
    }
  }, [isClient]);

  const handleOrientation = useCallback((event: DeviceOrientationEvent) => {
    const beta = event.beta || 0;
    const gamma = event.gamma || 0;
    const alpha = event.alpha || 0;
    
    currentOrientation.current = { alpha, beta, gamma };
    betaHistory.current.push(beta);
    gammaHistory.current.push(gamma);
    if (betaHistory.current.length > SMOOTHING_WINDOW * 2) {
      betaHistory.current.shift();
    }
    if (gammaHistory.current.length > SMOOTHING_WINDOW * 2) {
      gammaHistory.current.shift();
    }
    
    const smoothedBeta = smoothBeta(betaHistory.current);
    const smoothedGamma = smoothBeta(gammaHistory.current);
    
    const now = Date.now();
    const deltaBeta = baseBeta !== null ? smoothedBeta - baseBeta : smoothedBeta;

    if (SHOW_DEBUG) {
      setDebug(JSON.stringify({
        beta: beta.toFixed(2),
        gamma: gamma.toFixed(2),
        smoothedBeta: smoothedBeta.toFixed(2),
        deltaBeta: deltaBeta.toFixed(2),
        isArmed,
        baseBeta: baseBeta?.toFixed(2),
        distanceFromHorizontal: Math.abs(deltaBeta).toFixed(2),
        betaWithinThreshold: Math.abs(deltaBeta) <= HORIZONTAL_ARMED,
        gammaWithinThreshold: Math.abs(gamma) <= HORIZONTAL_ARMED,
        isCurrentlyHorizontal: Math.abs(deltaBeta) <= HORIZONTAL_ARMED && Math.abs(gamma) <= HORIZONTAL_ARMED
      }, null, 2));
    }
    
    // ARMED state: phone is horizontal relative to baseline
    const isCurrentlyHorizontal = isArmedRef.current
      ? isHorizontal(HORIZONTAL_UNARMED, deltaBeta, smoothedGamma)
      : isHorizontal(HORIZONTAL_ARMED, deltaBeta, smoothedGamma);
    
    if (isCurrentlyHorizontal && !isArmedRef.current && now - lastTrigger.current > RATE_LIMIT_MS) {
      // Transitioning from UNARMED to ARMED (horizontal)
      isArmedRef.current = true;
      setIsArmed(true);
      setArmedCounter(prev => prev + 1); // Increment counter
      emitArmed(); // Emit to server for global counter
      console.log('Triggering client-side morse audio...');
      addDebugLog('TRIGGER: Client-side morse audio');
      
      // Client-side trigger - play morse.mp3 directly
      addDebugLog('AUDIO: Triggering morse.mp3');
      playMorseAudio();
      
      // Still emit to server for counters (if connected)
      emitTrigger();
      lastTrigger.current = now;
      
      // Visual feedback - brief pulsating effect
      setIsArmedPulsing(true);
      setTimeout(() => {
        setIsArmedPulsing(false);
      }, 1000); // Pulse for 1 second
      
      // No audio feedback when armed - only trigger outputs
    } else if (!isCurrentlyHorizontal && isArmedRef.current) {
      // Transitioning from ARMED to UNARMED (not horizontal in both axes)
      isArmedRef.current = false;
      setIsArmed(false);

      // Stop any playing audio when leaving ARMED state
      stopMorseAudio();
      
      // No audio feedback when unarmed
    }
    
    // Remove all the old motion detection logic since we only care about ARMED/UNARMED states
    
  }, [emitTrigger, emitArmed, baseBeta, playMorseAudio, stopMorseAudio]);

  // Removed handleMotion since we only need orientation data

  const requestMotionPermission = async () => {
    try {
      if (
        typeof DeviceOrientationEvent !== 'undefined' &&
        // @ts-ignore – iOS non-standard
        typeof DeviceOrientationEvent.requestPermission === 'function'
      ) {
        // iOS
        // @ts-ignore
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') throw new Error('denied');
      }
      setMotionGranted(true);
      setNeedsPermission(false);
    } catch {
      alert('Motion permission denied. Tilt interaction disabled.');
    }
  };

  // Show permission overlay only until granted
  useEffect(() => {
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      // @ts-ignore
      typeof DeviceOrientationEvent.requestPermission === 'function'
    ) {
      setNeedsPermission(!motionGranted);
    } else {
      // Android/ desktop – permission happens implicitly via user gesture
      setMotionGranted(true);
    }
  }, [motionGranted]);

  // ------------ visibility handling --------------
  const attachOrientation = useCallback(() => {
    window.addEventListener('deviceorientation', handleOrientation as any, {
      passive: true,
    });
  }, [handleOrientation]);

  const detachOrientation = useCallback(() => {
    window.removeEventListener('deviceorientation', handleOrientation as any);
  }, [handleOrientation]);

  useEffect(() => {
    if (!motionGranted) return;
    attachOrientation();
    const vis = () => {
      if (document.visibilityState === 'visible') {
        betaHistory.current = [];
        setBaseBeta(null);
        attachOrientation();
      } else {
        detachOrientation();
      }
    };
    document.addEventListener('visibilitychange', vis);
    return () => {
      detachOrientation();
      document.removeEventListener('visibilitychange', vis);
    };
  }, [motionGranted, attachOrientation, detachOrientation]);

  // ---------- baseline capture after samples -------------
  useEffect(() => {
    if (baseBeta === null && betaHistory.current.length >= SAMPLE_COUNT_BASELINE) {
      setBaseBeta(smoothBeta(betaHistory.current));
    }
  });

  // --------------- helper isHorizontal ----------------
  const isHorizontal = (threshold:number, deltaB:number, gamma:number) =>
    Math.abs(deltaB) <= threshold && Math.abs(gamma) <= threshold;

  // Calculate enhanced colors based on current orientation
  const colors = (() => {
    if (isClient && betaHistory.current.length > 0 && baseBeta !== null) {
      const currentBeta = betaHistory.current[betaHistory.current.length - 1];
      return getOrientationColors(currentBeta, baseBeta);
    }
    return {
      background: '#000000',
      ambient: 'rgba(255, 64, 64, 0.2)',
      primary: '#ff4040',
      intensity: 0.4
    };
  })();

  // Handle socket actions
  useEffect(() => {
    if (!lastAction) return;

    console.log('Processing action in component:', lastAction);
    addDebugLog(`ACTION: Received ${lastAction.type}`);

    switch (lastAction.type) {
      case 'morseAudio':
        console.log('Attempting to play morse.mp3 audio');
        addDebugLog(' AUDIO: Attempting to play morse.mp3');
        // Play morse.mp3 audio file
        if (isClient && morseAudio.current) {
          console.log('Audio element found, playing...');
          addDebugLog(' AUDIO: Element ready, playing...');
          morseAudio.current.currentTime = 0;
          morseAudio.current.play().then(() => {
            addDebugLog(' AUDIO: Successfully started playing');
          }).catch((error: unknown) => {
            console.log('Audio play failed:', error);
            addDebugLog(` AUDIO: Play failed - ${error}`);
          });
        } else {
          console.log('Audio element not ready:', { isClient, audioElement: !!morseAudio.current });
          addDebugLog(` AUDIO: Not ready - client:${isClient}, element:${!!morseAudio.current}`);
        }
        break;
      default:
        console.log('Unhandled action type:', lastAction.type);
        addDebugLog(` ACTION: Unknown type ${lastAction.type}`);
        break;
    }
  }, [lastAction, isClient, addDebugLog]);

  // If banned, show ban screen
  if (isBanned) {
    return (
      <div className="fixed inset-0 bg-red-900 flex items-center justify-center">
        <div className="text-center text-white p-8">
          <h1 className="text-4xl font-bold mb-4">BANNED</h1>
          <p className="text-xl">{banMessage}</p>
          <p className="text-lg mt-4">You will be able to access the site again in 2 minutes.</p>
        </div>
      </div>
    );
  }

  return (
    <motion.div 
      className="fixed inset-0 flex items-center justify-center overflow-hidden transition-all duration-500"
      style={{ backgroundColor: colors.background }}
      animate={{
        scale: isArmedPulsing ? [1, 1.02, 1, 1.01, 1] : 1,
        opacity: isArmedPulsing ? [1, 0.9, 1, 0.95, 1] : 1,
      }}
      transition={{
        duration: 1,
        ease: "easeInOut",
        times: [0, 0.25, 0.5, 0.75, 1]
      }}
    >
      {/* Ambient glow that responds to orientation */}
      <div 
        className="absolute inset-0 pointer-events-none transition-all duration-500"
        style={{
          background: `radial-gradient(circle at center, ${colors.ambient} 0%, transparent 70%)`,
          opacity: colors.intensity
        }}
      />

      {/* Breathing effect when in ready position */}
      {!isArmed && isClient && betaHistory.current.length > 0 && baseBeta !== null && (
        Math.abs(betaHistory.current[betaHistory.current.length - 1] - baseBeta) < 10 && (
          <div 
            className="absolute inset-0 pointer-events-none animate-pulse"
            style={{
              background: `radial-gradient(circle at center, ${colors.primary}10 0%, transparent 50%)`,
              animationDuration: '2s'
            }}
          />
        )
      )}

      {/* Circular Motion Indicator - Only 2 circles */}
      <div className="flex items-center justify-center">
        <div className="relative w-40 h-40">
          {/* Traditional keyhole shape */}
          <div 
            className={`absolute inset-0 flex items-center justify-center transition-all duration-300 z-10 ${
              !isArmed ? 'animate-pulse' : ''
            }`}
            style={{ animationDuration: !isArmed ? '1s' : undefined }}
          >
            {/* Solid circular part - the crescent shape */}
            <div 
              style={{
                width: '50px',
                height: '50px',
                borderRadius: '50%',
                backgroundColor: isArmed ? '#00ff64' : colors.primary,
                border: `4px solid ${isArmed ? '#00ff64' : colors.primary}`,
                boxShadow: isArmed ? '0 0 20px #00ff64' : `0 0 15px ${colors.primary}`,
                position: 'relative',
                opacity: 0.8, // More solid than before
              }}
            >
              {/* White blinking overlay for circular part */}
              {!isArmed && (
                <div 
                  className="absolute animate-pulse"
                  style={{
                    top: '-4px',
                    left: '-4px',
                    width: '50px',
                    height: '50px',
                    borderRadius: '50%',
                    border: '4px solid white',
                    opacity: 0.3,
                    animationDuration: '0.8s',
                    animationDirection: 'alternate',
                    animationIterationCount: 'infinite',
                  }}
                />
              )}
            </div>
            
            {/* Rectangular slot part of keyhole */}
            <div 
              style={{
                width: '18px', // Match the cut-out width
                height: '30px',
                backgroundColor: 'transparent',
                borderLeft: `4px solid ${isArmed ? '#00ff64' : colors.primary}`,
                borderRight: `4px solid ${isArmed ? '#00ff64' : colors.primary}`,
                borderBottom: `4px solid ${isArmed ? '#00ff64' : colors.primary}`,
                borderTop: 'none', // Connect to circle
                borderRadius: '0 0 9px 9px', // Match the cut-out radius
                boxShadow: isArmed ? '0 0 20px #00ff64' : `0 0 15px ${colors.primary}`,
                position: 'absolute',
                left: '50%',
                top: '46px', // Position below the circle
                transform: 'translateX(-50%)',
              }}
            >
              {/* White blinking overlay for slot part */}
              {!isArmed && (
                <div 
                  className="absolute animate-pulse"
                  style={{
                    top: '-4px',
                    left: '-4px',
                    width: '18px', // Match the slot width
                    height: '30px',
                    borderLeft: '4px solid white',
                    borderRight: '4px solid white',
                    borderBottom: '4px solid white',
                    borderTop: 'none',
                    borderRadius: '0 0 9px 9px', // Match the slot radius
                    opacity: 0.3,
                    animationDuration: '0.8s',
                    animationDirection: 'alternate',
                    animationIterationCount: 'infinite',
                  }}
                />
              )}
            </div>
          </div>
          
          {/* Moving circle based on all gyro parameters */}
          {isClient && betaHistory.current.length > 0 && baseBeta !== null && (
            (() => {
              const currentBeta = smoothBeta(betaHistory.current);
              const currentGamma = smoothBeta(gammaHistory.current);
              
              // Calculate movement based on all gyro parameters
              const maxMovement = 60; // Maximum pixels the circle can move from center
              
              // Calculate offsets based on device orientation
              let horizontalOffset = 0;
              let verticalOffset = 0;
              
              if (Math.abs(currentBeta - (baseBeta ?? 0)) <= HORIZONTAL_ARMED && Math.abs(currentGamma) <= HORIZONTAL_ARMED) {
                // ARMED state - circle moves to center (overlapping with center circle)
                horizontalOffset = 0;
                verticalOffset = 0;
              } else {
                // Calculate offsets based on tilt
                // Beta controls vertical movement (forward/backward tilt)
                const betaNormalized = Math.max(-1, Math.min(1, currentBeta / 45));
                verticalOffset = betaNormalized * maxMovement;
                
                // Gamma controls horizontal movement (left/right tilt)
                const gammaNormalized = Math.max(-1, Math.min(1, currentGamma / 45));
                horizontalOffset = gammaNormalized * maxMovement;
              }
              
              // Start position: below the keyhole, ready to slide up into the slot
              const baseVerticalOffset = 50; // Start 50px below center to be below the keyhole
              
              return (
                <div 
                  className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 transition-all duration-300"
                  style={{
                    transform: `translate(calc(-50% + ${horizontalOffset}px), calc(-50% + ${baseVerticalOffset + verticalOffset}px)) rotate(180deg)`,
                    width: '14px', // Slightly larger to fit perfectly in the 18px slot
                    height: '26px', // Slightly taller for better fit
                    borderRadius: '7px 7px 3px 3px', // Proportionally adjusted radius
                    backgroundColor: isArmed ? '#00ff64' : colors.primary,
                    border: `2px solid ${isArmed ? '#00ff64' : colors.primary}`,
                    boxShadow: isArmed ? `0 0 15px ${isArmed ? '#00ff64' : colors.primary}` : `0 0 12px ${colors.primary}`,
                    zIndex: isArmed ? 15 : 5, // Higher z-index when armed to show it's "inserted"
                  }}
                />
              );
            })()
          )}
        </div>
      </div>

      {/* Debug overlay */}
      {SHOW_DEBUG && debug && (
        <div style={{
          position: 'absolute', top: 0, left: 0, color: 'lime', background: 'rgba(0,0,0,0.7)', zIndex: 9999, fontSize: 12, padding: 8, maxWidth: 400, whiteSpace: 'pre-wrap', wordBreak: 'break-all', pointerEvents: 'none'
        }}>{debug}</div>
      )}
      
      {/* Status indicator */}
      <div style={{
        position: 'absolute', top: 0, right: 0, color: 'cyan', background: 'rgba(0,0,0,0.7)', zIndex: 9999, fontSize: 14, padding: 8, pointerEvents: 'none'
      }}>
        STATE: {isArmed ? 'ARMED' : 'UNARMED'} (isArmed={isArmed.toString()})<br/>
        Distance from Horizontal: {isClient && betaHistory.current.length > 0 && baseBeta !== null ? Math.abs(betaHistory.current[betaHistory.current.length - 1] - baseBeta).toFixed(1) : '0'}°<br/>
        Gamma: {isClient && currentOrientation.current ? currentOrientation.current.gamma.toFixed(1) : '0'}°<br/>
        Local Armed: {armedCounter}<br/>
        Global Armed: {globalCounter}<br/>
        Global Erections: {erectionCounter}<br/>
        Users: {userCount}<br/>
        Connected: {isConnected ? '✓' : '✗'}
      </div>

      {/* Debug logs display */}
      {SHOW_DEBUG && debugLogs.length > 0 && (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, color: 'yellow', background: 'rgba(0,0,0,0.8)', zIndex: 9999, fontSize: 12, padding: 8, maxHeight: '200px', overflow: 'auto', pointerEvents: 'none'
        }}>
          <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>DEBUG LOGS:</div>
          {debugLogs.map((log, index) => (
            <div key={index} style={{ marginBottom: '2px' }}>{log}</div>
          ))}
        </div>
      )}

      {/* Test audio button */}
      <button
        onClick={() => {
          addDebugLog('🧪 TEST: Manual test');
          playMorseAudio();
        }}
        style={{
          position: 'absolute',
          top: '50%',
          right: '10px',
          transform: 'translateY(-50%)',
          padding: '10px',
          backgroundColor: '#ff4040',
          color: 'white',
          border: 'none',
          borderRadius: '5px',
          fontSize: '12px',
          cursor: 'pointer',
          zIndex: 10000,
          pointerEvents: 'auto'
        }}
      >
        testear audio
      </button>

      {/* Permission overlay */}
      {needsPermission && !permissionRequested && (
        <div style={{
          position: 'fixed', inset: 0, background: 'black', zIndex: 10000, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto'
        }}>
          <button
            onClick={requestMotionPermission}
            style={{ 
              pointerEvents: 'auto',
              width: '200px',
              height: '200px',
              borderRadius: '50%',
              backgroundColor: '#ff4040',
              border: '4px solid #ff4040',
              color: 'white',
              fontSize: '24px',
              fontWeight: 'bold',
              cursor: 'pointer',
              boxShadow: '0 0 30px rgba(255, 64, 64, 0.5)',
              transition: 'all 0.3s ease',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            onMouseEnter={(e) => {
              const target = e.target as HTMLButtonElement;
              target.style.transform = 'scale(1.05)';
              target.style.boxShadow = '0 0 40px rgba(255, 64, 64, 0.7)';
            }}
            onMouseLeave={(e) => {
              const target = e.target as HTMLButtonElement;
              target.style.transform = 'scale(1)';
              target.style.boxShadow = '0 0 30px rgba(255, 64, 64, 0.5)';
            }}
          >
            Aceptas?
          </button>
        </div>
      )}

      {/* Audio elements - only render on client */}
      {isClient && (
        <audio ref={morseAudio} preload="auto">
          <source src="/morse.mp3" type="audio/mpeg" />
        </audio>
      )}

      {/* CSS for animations */}
      <style jsx>{`
        @keyframes phallicGrow {
          from { height: 0; opacity: 0; }
          to   { height: 200px; opacity: 1; }
        }
      `}</style>
    </motion.div>
  );
};