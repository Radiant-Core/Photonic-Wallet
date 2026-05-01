import { useState, useCallback, useRef } from "react";
import { electrumWorker } from "@app/electrum/Electrum";
import { validateWaveName } from "@lib/wave";

interface WaveResolutionResult {
  resolvedAddress: string | null;
  isResolving: boolean;
  error: string | null;
  isWaveName: boolean;
}

interface UseWaveResolverReturn extends WaveResolutionResult {
  resolveName: (input: string) => Promise<string | null>;
  clear: () => void;
}

/**
 * Hook for resolving WAVE names (.rxd) to addresses
 * Can be used in send forms to support sending to WAVE names
 */
export function useWaveResolver(): UseWaveResolverReturn {
  const [resolvedAddress, setResolvedAddress] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isWaveName, setIsWaveName] = useState(false);
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);

  const resolveName = useCallback(async (input: string): Promise<string | null> => {
    // Clear any pending debounce
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    // Reset state
    setError(null);
    setResolvedAddress(null);

    // Check if it looks like a WAVE name
    const fullName = input.includes(".") ? input : `${input}.rxd`;
    const validation = validateWaveName(fullName);

    if (!validation.valid) {
      setIsWaveName(false);
      return null;
    }

    setIsWaveName(true);

    // Return a promise that resolves after debounce
    return new Promise((resolve) => {
      debounceTimer.current = setTimeout(async () => {
        setIsResolving(true);
        try {
          const result = await electrumWorker.value.resolveWaveName(fullName);
          if (result) {
            setResolvedAddress(result.target);
            setError(null);
            resolve(result.target);
          } else {
            setError(`Name "${fullName}" not found`);
            setResolvedAddress(null);
            resolve(null);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Resolution failed";
          setError(msg);
          setResolvedAddress(null);
          resolve(null);
        } finally {
          setIsResolving(false);
        }
      }, 500); // 500ms debounce
    });
  }, []);

  const clear = useCallback(() => {
    setResolvedAddress(null);
    setError(null);
    setIsWaveName(false);
    setIsResolving(false);
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
  }, []);

  return {
    resolvedAddress,
    isResolving,
    error,
    isWaveName,
    resolveName,
    clear,
  };
}

/**
 * Check if an input string is potentially a WAVE name
 */
export function isPotentialWaveName(input: string): boolean {
  if (!input || input.length < 3) return false;
  const fullName = input.includes(".") ? input : `${input}.rxd`;
  const validation = validateWaveName(fullName);
  return validation.valid;
}

export default useWaveResolver;
