/**
 * Encryption Mode Selector Component
 *
 * Allows choosing between passphrase-based or recipient-based encryption.
 */

import { useState } from "react";
import type { EncryptionMode } from "../encryptionService";

export type EncryptionModeSelectorProps = {
  /** Current encryption mode */
  mode: EncryptionMode;
  /** Callback when mode changes */
  onChange: (mode: EncryptionMode) => void;
  /** Passphrase value */
  passphrase?: string;
  /** Callback when passphrase changes */
  onPassphraseChange?: (passphrase: string) => void;
  /** Recipient public keys */
  recipientKeys?: string[];
  /** Callback to add recipient */
  onAddRecipient?: () => void;
  /** Callback to remove recipient */
  onRemoveRecipient?: (index: number) => void;
  /** Whether disabled */
  disabled?: boolean;
};

/**
 * Mode selector for encryption type (passphrase vs recipient)
 */
export function EncryptionModeSelector({
  mode,
  onChange,
  passphrase,
  onPassphraseChange,
  recipientKeys,
  onAddRecipient,
  onRemoveRecipient,
  disabled = false,
}: EncryptionModeSelectorProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [passphraseStrength, setPassphraseStrength] = useState(0);

  const evaluateStrength = (pass: string): number => {
    let score = 0;
    if (pass.length >= 8) score += 20;
    if (pass.length >= 12) score += 20;
    if (/[A-Z]/.test(pass)) score += 15;
    if (/[a-z]/.test(pass)) score += 15;
    if (/[0-9]/.test(pass)) score += 15;
    if (/[^A-Za-z0-9]/.test(pass)) score += 15;
    return Math.min(score, 100);
  };

  const handlePassphraseChange = (value: string) => {
    setPassphraseStrength(evaluateStrength(value));
    onPassphraseChange?.(value);
  };

  const getStrengthColor = (score: number): string => {
    if (score < 40) return "#dc3545"; // Weak - red
    if (score < 70) return "#ffc107"; // Medium - yellow
    return "#28a745"; // Strong - green
  };

  const getStrengthLabel = (score: number): string => {
    if (score < 40) return "Weak";
    if (score < 70) return "Medium";
    return "Strong";
  };

  return (
    <div className="encryption-mode-selector">
      <div className="mode-tabs">
        <button
          className={`mode-tab ${mode === "passphrase" ? "active" : ""}`}
          onClick={() => onChange("passphrase")}
          disabled={disabled}
          type="button"
        >
          🔑 Passphrase
        </button>
        <button
          className={`mode-tab ${mode === "recipient" ? "active" : ""}`}
          onClick={() => onChange("recipient")}
          disabled={disabled}
          type="button"
        >
          👤 Recipients
        </button>
      </div>

      {mode === "passphrase" && (
        <div className="passphrase-section">
          <label className="input-label">
            Encryption Passphrase
            <span className="required">*</span>
          </label>
          <div className="passphrase-input-row">
            <input
              type={showPassword ? "text" : "password"}
              value={passphrase || ""}
              onChange={(e) => handlePassphraseChange(e.target.value)}
              placeholder="Enter a strong passphrase..."
              disabled={disabled}
              className="passphrase-input"
            />
            <button
              className="toggle-visibility"
              onClick={() => setShowPassword(!showPassword)}
              type="button"
              aria-label={showPassword ? "Hide passphrase" : "Show passphrase"}
            >
              {showPassword ? "🙈" : "👁️"}
            </button>
          </div>

          {passphrase && (
            <div className="strength-meter">
              <div
                className="strength-bar"
                style={{
                  '--strength-width': `${passphraseStrength}%`,
                  '--strength-color': getStrengthColor(passphraseStrength),
                } as React.CSSProperties}
              />
              <span
                className="strength-label"
                style={{ '--strength-color': getStrengthColor(passphraseStrength) } as React.CSSProperties}
              >
                {getStrengthLabel(passphraseStrength)}
              </span>
            </div>
          )}

          <p className="help-text">
            This passphrase will be required to decrypt the content.
            <strong> Store it securely - it cannot be recovered!</strong>
          </p>
        </div>
      )}

      {mode === "recipient" && (
        <div className="recipient-section">
          <label className="input-label">Recipients</label>
          {recipientKeys && recipientKeys.length > 0 && (
            <div className="recipient-list">
              {recipientKeys.map((key, index) => (
                <div key={index} className="recipient-item">
                  <span className="recipient-address">
                    {key.slice(0, 20)}...{key.slice(-8)}
                  </span>
                  <button
                    className="remove-recipient"
                    onClick={() => onRemoveRecipient?.(index)}
                    disabled={disabled}
                    type="button"
                    aria-label={`Remove recipient ${index + 1}`}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <button
            className="add-recipient-btn"
            onClick={onAddRecipient}
            disabled={disabled}
            type="button"
          >
            + Add Recipient
          </button>

          <p className="help-text">
            Add recipients by WAVE name, address, or scan QR code.
            Only recipients with the corresponding private key can decrypt.
          </p>
        </div>
      )}

      <style>{`
        .encryption-mode-selector {
          margin: 16px 0;
        }

        .mode-tabs {
          display: flex;
          gap: 8px;
          margin-bottom: 16px;
        }

        .mode-tab {
          flex: 1;
          padding: 10px 16px;
          border: 2px solid #e0e0e0;
          background: white;
          border-radius: 8px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
          transition: all 0.2s;
        }

        .mode-tab:hover:not(:disabled) {
          border-color: #4caf50;
          background: rgba(76, 175, 80, 0.05);
        }

        .mode-tab.active {
          border-color: #4caf50;
          background: rgba(76, 175, 80, 0.1);
          color: #2e7d32;
        }

        .mode-tab:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .passphrase-section,
        .recipient-section {
          padding: 12px;
          background: rgba(0, 0, 0, 0.02);
          border-radius: 8px;
        }

        .input-label {
          display: block;
          font-size: 13px;
          font-weight: 600;
          color: #333;
          margin-bottom: 8px;
        }

        .required {
          color: #dc3545;
          margin-left: 4px;
        }

        .passphrase-input-row {
          display: flex;
          gap: 8px;
        }

        .passphrase-input {
          flex: 1;
          padding: 10px 12px;
          border: 1px solid #ddd;
          border-radius: 6px;
          font-size: 14px;
          transition: border-color 0.2s;
        }

        .passphrase-input:focus {
          outline: none;
          border-color: #4caf50;
          box-shadow: 0 0 0 2px rgba(76, 175, 80, 0.2);
        }

        .passphrase-input:disabled {
          background: #f5f5f5;
        }

        .toggle-visibility {
          padding: 8px 12px;
          background: white;
          border: 1px solid #ddd;
          border-radius: 6px;
          cursor: pointer;
          font-size: 16px;
        }

        .toggle-visibility:hover {
          background: #f5f5f5;
        }

        .strength-meter {
          margin-top: 8px;
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .strength-bar {
          flex: 1;
          height: 4px;
          border-radius: 2px;
          transition: all 0.3s;
          background-color: #dc3545;
        }

        .strength-label {
          font-size: 12px;
          font-weight: 500;
        }

        .help-text {
          margin: 12px 0 0 0;
          font-size: 12px;
          color: #666;
          line-height: 1.4;
        }

        .recipient-list {
          margin-bottom: 12px;
        }

        .recipient-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 12px;
          background: white;
          border: 1px solid #e0e0e0;
          border-radius: 6px;
          margin-bottom: 8px;
        }

        .recipient-address {
          font-family: monospace;
          font-size: 13px;
          color: #333;
        }

        .remove-recipient {
          background: none;
          border: none;
          color: #dc3545;
          cursor: pointer;
          font-size: 14px;
          padding: 4px;
        }

        .remove-recipient:hover {
          background: rgba(220, 53, 69, 0.1);
          border-radius: 4px;
        }

        .add-recipient-btn {
          width: 100%;
          padding: 10px;
          background: white;
          border: 2px dashed #4caf50;
          border-radius: 6px;
          color: #4caf50;
          cursor: pointer;
          font-weight: 500;
          transition: all 0.2s;
        }

        .add-recipient-btn:hover:not(:disabled) {
          background: rgba(76, 175, 80, 0.05);
        }

        .add-recipient-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}
