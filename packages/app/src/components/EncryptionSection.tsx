/**
 * Encryption Section - Composite component for minting flow integration
 *
 * Combines EncryptToggle, EncryptionModeSelector, and progress display
 * into a single section that can be dropped into Mint.tsx.
 */

import { useState, useMemo } from "react";
import { EncryptToggle } from "./EncryptToggle";
import { EncryptionModeSelector } from "./EncryptionModeSelector";
import { EncryptionProgress } from "./EncryptionProgress";
import { StorageBackendSelector, type StorageBackend } from "./StorageBackendSelector";
import type {
  EncryptionMode,
  EncryptionProgress as ProgressType,
} from "../encryptionService";
import { estimateEncryptedSize, formatBytes } from "../encryptionService";
import db from "@app/db";
import { GLYPH_WAVE } from "@lib/protocols";

export type EncryptionSectionState = {
  enabled: boolean;
  mode: EncryptionMode;
  passphrase: string;
  recipientKeys: string[];
  storageBackend: StorageBackend;
};

export type EncryptionSectionProps = {
  /** Current encryption state */
  state: EncryptionSectionState;
  /** Callback when state changes */
  onChange: (state: EncryptionSectionState) => void;
  /** File size in bytes (for estimates) */
  fileSize?: number;
  /** Optional progress state during encryption */
  progress?: ProgressType | null;
  /** Whether encryption is in-flight */
  isEncrypting?: boolean;
  /** Error message */
  error?: string | null;
  /** Whether controls should be disabled */
  disabled?: boolean;
};

/**
 * Composite encryption section for mint flow
 */
export function EncryptionSection({
  state,
  onChange,
  fileSize,
  progress,
  isEncrypting = false,
  error,
  disabled = false,
}: EncryptionSectionProps) {
  const [newRecipient, setNewRecipient] = useState("");
  const [showAddRecipient, setShowAddRecipient] = useState(false);
  const [recipientKeyError, setRecipientKeyError] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(false);

  const isValidX25519HexKey = (key: string): boolean =>
    key.length === 64 && /^[0-9a-fA-F]+$/.test(key);

  /**
   * Resolve a WAVE name (e.g. "alice.rxd") or raw hex key.
   * Returns the X25519 hex public key on success, or null with an error set.
   */
  const resolveRecipientInput = async (input: string): Promise<string | null> => {
    const trimmed = input.trim();

    // Already a valid hex key — use it directly
    if (isValidX25519HexKey(trimmed)) {
      return trimmed;
    }

    // WAVE name: ends with .rxd or looks like name.domain
    if (trimmed.includes(".") || /^[a-z0-9-]{3,63}$/i.test(trimmed)) {
      setIsResolving(true);
      try {
        const glyphs = await db.glyph.toArray();
        const waveTokens = glyphs.filter(
          (g) => Array.isArray(g.p) && g.p.includes(GLYPH_WAVE)
        );

        const normalized = trimmed.toLowerCase().replace(/\.rxd$/, "");
        const match = waveTokens.find((g) => {
          const tokenName = (g.name || "").toLowerCase().replace(/\.rxd$/, "");
          return tokenName === normalized;
        });

        if (!match) {
          setRecipientKeyError(
            `WAVE name "${trimmed}" not found in local wallet. Ask the recipient to share their X25519 public key directly.`
          );
          return null;
        }

        const records = (match as any)?.attrs?.records as Record<string, string> | undefined;
        const x25519pub = records?.x25519_pub;

        if (!x25519pub) {
          setRecipientKeyError(
            `WAVE name "${trimmed}" found but has no x25519_pub encryption key in its records.`
          );
          return null;
        }

        if (!isValidX25519HexKey(x25519pub)) {
          setRecipientKeyError(
            `WAVE name "${trimmed}" has an invalid x25519_pub value (expected 64 hex chars).`
          );
          return null;
        }

        return x25519pub;
      } finally {
        setIsResolving(false);
      }
    }

    setRecipientKeyError(
      "Invalid input. Enter a 64-character hex X25519 public key or a WAVE name (e.g. alice.rxd)."
    );
    return null;
  };

  const estimate = useMemo(() => {
    if (!fileSize || !state.enabled) return null;
    const est = estimateEncryptedSize(fileSize);
    return {
      ...est,
      humanSize: formatBytes(est.encryptedSize),
    };
  }, [fileSize, state.enabled]);

  const handleToggle = (enabled: boolean) => {
    onChange({ ...state, enabled });
  };

  const handleModeChange = (mode: EncryptionMode) => {
    onChange({ ...state, mode });
  };

  const handlePassphraseChange = (passphrase: string) => {
    onChange({ ...state, passphrase });
  };

  const handleStorageBackendChange = (storageBackend: StorageBackend) => {
    onChange({ ...state, storageBackend });
  };

  const handleAddRecipient = async () => {
    const trimmed = newRecipient.trim();
    if (!trimmed) {
      setShowAddRecipient(true);
      return;
    }
    setRecipientKeyError(null);
    const resolvedKey = await resolveRecipientInput(trimmed);
    if (!resolvedKey) return;
    onChange({
      ...state,
      recipientKeys: [...state.recipientKeys, resolvedKey],
    });
    setNewRecipient("");
    setShowAddRecipient(false);
  };

  const handleRemoveRecipient = (index: number) => {
    onChange({
      ...state,
      recipientKeys: state.recipientKeys.filter((_, i) => i !== index),
    });
  };

  const isValid = state.enabled
    ? state.mode === "passphrase"
      ? state.passphrase.length >= 8
      : state.recipientKeys.length > 0
    : true;

  return (
    <div className="encryption-section">
      <EncryptToggle
        enabled={state.enabled}
        onChange={handleToggle}
        disabled={disabled || isEncrypting}
        estimatedSize={estimate?.humanSize}
        numChunks={estimate?.numChunks}
      />

      {state.enabled && (
        <>
          <StorageBackendSelector
            backend={state.storageBackend}
            onChange={handleStorageBackendChange}
            fileSize={fileSize}
            disabled={disabled || isEncrypting}
          />

          <EncryptionModeSelector
            mode={state.mode}
            onChange={handleModeChange}
            passphrase={state.passphrase}
            onPassphraseChange={handlePassphraseChange}
            recipientKeys={state.recipientKeys}
            onAddRecipient={() => setShowAddRecipient(true)}
            onRemoveRecipient={handleRemoveRecipient}
            disabled={disabled || isEncrypting}
          />

          {showAddRecipient && (
            <div className="add-recipient-form">
              <label className="form-label">
                Recipient — WAVE name (e.g. alice.rxd) or X25519 public key (64 hex chars)
              </label>
              <div className="form-input-row">
                <input
                  type="text"
                  value={newRecipient}
                  onChange={(e) => {
                    setNewRecipient(e.target.value);
                    setRecipientKeyError(null);
                  }}
                  placeholder="alice.rxd or a1b2c3d4... (64 hex)"
                  className={`form-input${recipientKeyError ? " form-input-error" : ""}`}
                  disabled={disabled || isEncrypting || isResolving}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddRecipient();
                    }
                  }}
                />
                <button
                  className="btn-add"
                  onClick={handleAddRecipient}
                  disabled={disabled || isEncrypting || isResolving || !newRecipient.trim()}
                  type="button"
                >
                  {isResolving ? "Resolving…" : "Add"}
                </button>
                <button
                  className="btn-cancel"
                  onClick={() => {
                    setShowAddRecipient(false);
                    setNewRecipient("");
                  }}
                  disabled={disabled || isEncrypting}
                  type="button"
                >
                  Cancel
                </button>
              </div>
              {recipientKeyError && (
                <p className="recipient-key-error">{recipientKeyError}</p>
              )}
            </div>
          )}

          {state.enabled && !isValid && (
            <div className="validation-warning">
              {state.mode === "passphrase"
                ? "⚠️ Passphrase must be at least 8 characters"
                : "⚠️ Add at least one recipient"}
            </div>
          )}

          {(progress || isEncrypting || error) && (
            <div className="progress-container">
              <EncryptionProgress
                progress={progress ?? null}
                operation="encrypting"
                error={error}
              />
            </div>
          )}
        </>
      )}

      <style>{`
        .encryption-section {
          margin: 16px 0;
          padding: 16px;
          background: linear-gradient(
            135deg,
            rgba(102, 126, 234, 0.03) 0%,
            rgba(118, 75, 162, 0.03) 100%
          );
          border-radius: 12px;
          border: 1px solid rgba(102, 126, 234, 0.15);
        }

        .add-recipient-form {
          margin-top: 12px;
          padding: 12px;
          background: white;
          border-radius: 8px;
          border: 1px solid #e0e0e0;
        }

        .form-label {
          display: block;
          font-size: 13px;
          font-weight: 600;
          color: #333;
          margin-bottom: 8px;
        }

        .form-input-row {
          display: flex;
          gap: 8px;
        }

        .form-input {
          flex: 1;
          padding: 8px 12px;
          border: 1px solid #ddd;
          border-radius: 6px;
          font-size: 14px;
        }

        .form-input:focus {
          outline: none;
          border-color: #667eea;
        }

        .form-input-error {
          border-color: #e53e3e;
        }

        .recipient-key-error {
          margin: 4px 0 0;
          font-size: 12px;
          color: #e53e3e;
        }

        .btn-add,
        .btn-cancel {
          padding: 8px 16px;
          border-radius: 6px;
          font-weight: 500;
          cursor: pointer;
          font-size: 14px;
        }

        .btn-add {
          background: #667eea;
          border: none;
          color: white;
        }

        .btn-add:hover:not(:disabled) {
          opacity: 0.9;
        }

        .btn-add:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .btn-cancel {
          background: white;
          border: 1px solid #ddd;
          color: #666;
        }

        .btn-cancel:hover:not(:disabled) {
          background: #f5f5f5;
        }

        .validation-warning {
          margin-top: 12px;
          padding: 8px 12px;
          background: rgba(255, 193, 7, 0.1);
          border-left: 3px solid #ffc107;
          border-radius: 4px;
          font-size: 13px;
          color: #856404;
        }

        .progress-container {
          margin-top: 12px;
        }
      `}</style>
    </div>
  );
}

/**
 * Initial state for EncryptionSection
 */
export const initialEncryptionState: EncryptionSectionState = {
  enabled: false,
  mode: "passphrase",
  passphrase: "",
  recipientKeys: [],
  storageBackend: "ipfs",
};

/**
 * Check if encryption state is valid for submission
 */
export function isEncryptionStateValid(state: EncryptionSectionState): boolean {
  if (!state.enabled) return true;
  if (state.mode === "passphrase") {
    return state.passphrase.length >= 8;
  }
  return state.recipientKeys.length > 0;
}
