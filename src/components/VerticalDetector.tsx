import { useEffect, useState, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { useSocket } from '@/hooks/useSocket';

const RATE_LIMIT_MS = 3000;
const SMOOTHING_WINDOW = 8;
const HORIZONTAL_ARMED = 5;  // degrees
const HORIZONTAL_UNARMED = 8; // degrees – hysteresis
const SAMPLE_COUNT_BASELINE = 10;
const SHOW_DEBUG = false;
const UPDATE_THROTTLE_MS = 50;
const KEY_BOTTOM_Y = 90; // px offset when phone is vertical
const KEY_TOP_Y = 32;   // px offset when phone is fully horizontal (inside slot)

function smoothBeta(values: number[], windowSize: number = SMOOTHING_WINDOW): number {
  if (values.length === 0) return 0;
  const window = values.slice(-windowSize);
  return window.reduce((sum, val) => sum + val, 0) / window.length;
}

// Enhanced smoothing for visual movement
function smoothMovement(values: number[], windowSize: number = 8): number {
  if (values.length === 0) return 0;
  const window = values.slice(-windowSize);
  // Apply exponential smoothing for even smoother movement
  let smoothed = window[0];
  for (let i = 1; i < window.length; i++) {
    smoothed = smoothed * 0.7 + window[i] * 0.3;
  }
  return smoothed;
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

  // Add visual position state for smoother movement – start at the bottom offset
  const [visualPosition, setVisualPosition] = useState({ x: 0, y: KEY_BOTTOM_Y });
  const lastVisualUpdate = useRef(0);
  const visualBetaHistory = useRef<number[]>([]);
  const visualGammaHistory = useRef<number[]>([]);

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
    if (betaHistory.current.length > SMOOTHING_WINDOW * 2) {
      betaHistory.current.shift();
    }
    
    // Add to visual smoothing arrays
    visualBetaHistory.current.push(beta);
    visualGammaHistory.current.push(gamma);
    if (visualBetaHistory.current.length > 15) {
      visualBetaHistory.current.shift();
      visualGammaHistory.current.shift();
    }
    
    const smoothedBeta = smoothBeta(betaHistory.current);
    const now = Date.now();
    
    const deltaBeta = baseBeta !== null ? smoothedBeta - baseBeta : smoothedBeta;

    // Only update debug in development and throttle it
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
    
    // Throttled visual position updates for smoother movement
    if (now - lastVisualUpdate.current > UPDATE_THROTTLE_MS) {
      const smoothedVisualBeta = smoothMovement(visualBetaHistory.current);
      const smoothedVisualGamma = smoothMovement(visualGammaHistory.current);
      
      // Calculate vertical progress based on deltaBeta (relative to baseline)
      const effectiveBase = baseBeta !== null ? baseBeta : Math.abs(smoothedVisualBeta) || 45;
      const progressRaw = effectiveBase !== 0 ? (effectiveBase - (baseBeta !== null ? smoothedVisualBeta : Math.abs(smoothedVisualBeta))) / effectiveBase : 0;
      const verticalProgress = clamp(progressRaw, 0, 1); // 0 (bottom) -> 1 (top)

      // Map progress to Y offset
      const verticalOffset = KEY_BOTTOM_Y - verticalProgress * (KEY_BOTTOM_Y - KEY_TOP_Y);

      // Horizontal offset still based on gamma
      const gammaNormalized = clamp(smoothedVisualGamma / 45, -1, 1);
      const horizontalOffset = gammaNormalized * 60;

      setVisualPosition({ x: horizontalOffset, y: verticalOffset });
      lastVisualUpdate.current = now;
    }
    
    // ARMED state logic (unchanged)
    const isCurrentlyHorizontal = isArmedRef.current
      ? isHorizontal(HORIZONTAL_UNARMED, deltaBeta, gamma)
      : isHorizontal(HORIZONTAL_ARMED, deltaBeta, gamma);
    
    if (isCurrentlyHorizontal && !isArmedRef.current && now - lastTrigger.current > RATE_LIMIT_MS) {
      // Transitioning from UNARMED to ARMED (horizontal)
      isArmedRef.current = true;
      setIsArmed(true);
      setArmedCounter(prev => prev + 1);
      emitArmed();
      console.log('Triggering client-side morse audio...');
      if (SHOW_DEBUG) addDebugLog('TRIGGER: Client-side morse audio');
      
      if (SHOW_DEBUG) addDebugLog('AUDIO: Triggering morse.mp3');
      playMorseAudio();
      lastTrigger.current = now;
      
      setIsArmedPulsing(true);
      setTimeout(() => setIsArmedPulsing(false), 1000);
      
    } else if (!isCurrentlyHorizontal && isArmedRef.current) {
      // Transitioning from ARMED to UNARMED (not horizontal)
      isArmedRef.current = false;
      setIsArmed(false);
      stopMorseAudio();
    }
  }, [baseBeta, isArmed, emitArmed, playMorseAudio, stopMorseAudio, addDebugLog]);

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
          {/* Traditional keyhole shape - FIXED CENTERING */}
          <div 
            className={`absolute transition-all duration-300 z-10 ${
              !isArmed ? 'animate-pulse' : ''
            }`}
            style={{
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, calc(-50% + 15px))', // Properly centered
              animationDuration: !isArmed ? '1s' : undefined,
            }}
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
                opacity: 0.8,
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
                width: '18px',
                height: '30px',
                backgroundColor: 'transparent',
                borderLeft: `4px solid ${isArmed ? '#00ff64' : colors.primary}`,
                borderRight: `4px solid ${isArmed ? '#00ff64' : colors.primary}`,
                borderBottom: `4px solid ${isArmed ? '#00ff64' : colors.primary}`,
                borderTop: 'none',
                borderRadius: '0 0 9px 9px',
                boxShadow: isArmed ? '0 0 20px #00ff64' : `0 0 15px ${colors.primary}`,
                position: 'absolute',
                left: '50%',
                top: '46px',
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
                    width: '18px',
                    height: '30px',
                    borderLeft: '4px solid white',
                    borderRight: '4px solid white',
                    borderBottom: '4px solid white',
                    borderTop: 'none',
                    borderRadius: '0 0 9px 9px',
                    opacity: 0.3,
                    animationDuration: '0.8s',
                    animationDirection: 'alternate',
                    animationIterationCount: 'infinite',
                  }}
                />
              )}
            </div>
          </div>
          
          {/* Moving key – always rendered & animated with Framer Motion for smoothness */}
          {isClient && (
            <motion.div
              className="absolute"
              style={{
                top: '50%',
                left: '50%',
                // keep the element centred, rotation comes first so spring only affects position
                transform: 'translate(-50%, -50%) rotate(180deg)',
                width: '14px',
                height: '26px',
                borderRadius: '7px 7px 3px 3px',
                backgroundColor: isArmed ? '#00ff64' : colors.primary,
                border: `2px solid ${isArmed ? '#00ff64' : colors.primary}`,
                boxShadow: isArmed ? `0 0 15px #00ff64` : `0 0 12px ${colors.primary}`,
                zIndex: isArmed ? 15 : 5,
              }}
              animate={{ x: visualPosition.x, y: visualPosition.y }}
              transition={{ type: 'spring', stiffness: 160, damping: 22 }}
            />
          )}
        </div>
      </div>

      {/* Hide all debug UI elements */}
      {SHOW_DEBUG && debug && (
        <div style={{
          position: 'absolute', top: 0, left: 0, color: 'lime', background: 'rgba(0,0,0,0.7)', zIndex: 9999, fontSize: 12, padding: 8, maxWidth: 400, whiteSpace: 'pre-wrap', wordBreak: 'break-all', pointerEvents: 'none'
        }}>{debug}</div>
      )}
      
      {/* Hide status indicator */}
      {SHOW_DEBUG && (
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
      )}

      {/* Hide debug logs */}
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

      {/* Hide test audio button */}
      {SHOW_DEBUG && (
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
      )}

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

const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));