/**
 * Encrypt Toggle Component
 *
 * Toggle switch for enabling content encryption in the minting flow.
 * Shows encryption status and basic information.
 */

import { useState } from "react";

export type EncryptToggleProps = {
  /** Whether encryption is enabled */
  enabled: boolean;
  /** Callback when toggle changes */
  onChange: (enabled: boolean) => void;
  /** Whether the toggle is disabled */
  disabled?: boolean;
  /** Estimated file size after encryption */
  estimatedSize?: string;
  /** Number of chunks */
  numChunks?: number;
};

/**
 * Toggle switch for enabling content encryption
 */
export function EncryptToggle({
  enabled,
  onChange,
  disabled = false,
  estimatedSize,
  numChunks,
}: EncryptToggleProps) {
  const [showInfo, setShowInfo] = useState(false);

  return (
    <div className="encrypt-toggle">
      <div className="toggle-row">
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onChange(e.target.checked)}
            disabled={disabled}
            aria-label="Enable encryption"
          />
          <span className="toggle-slider"></span>
        </label>
        <span className="toggle-label">
          {enabled ? "🔒 Encryption Enabled" : "🔓 Encryption Disabled"}
        </span>
        <button
          className="info-button"
          onClick={() => setShowInfo(!showInfo)}
          type="button"
          aria-label="Encryption information"
        >
          ℹ️
        </button>
      </div>

      {enabled && estimatedSize && (
        <div className="size-estimate">
          <span className="estimate-label">Estimated size:</span>
          <span className="estimate-value">{estimatedSize}</span>
          {numChunks !== undefined && (
            <span className="chunks-info">({numChunks} chunks)</span>
          )}
        </div>
      )}

      {showInfo && (
        <div className="encryption-info">
          <p>
            <strong>Content Encryption</strong> protects your NFT content using
            XChaCha20-Poly1305 encryption. The encrypted content is stored
            off-chain with only a hash commitment on the blockchain.
          </p>
          <ul>
            <li>🔐 Content is encrypted before leaving your device</li>
            <li>📦 Encrypted content stored off-chain (IPFS or backend)</li>
            <li>🔗 Only content hash stored on-chain for verification</li>
            <li>🗝️ Access controlled by passphrase or recipient keys</li>
          </ul>
          <p className="security-note">
            <strong>Security Note:</strong> Keep your passphrase or private keys
            safe. Losing them means permanent loss of access to your encrypted
            content.
          </p>
        </div>
      )}

      <style>{`
        .encrypt-toggle {
          padding: 12px 16px;
          background: rgba(0, 0, 0, 0.05);
          border-radius: 8px;
          margin: 8px 0;
        }

        .toggle-row {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .toggle-switch {
          position: relative;
          display: inline-block;
          width: 48px;
          height: 24px;
        }

        .toggle-switch input {
          opacity: 0;
          width: 0;
          height: 0;
        }

        .toggle-slider {
          position: absolute;
          cursor: pointer;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: #ccc;
          transition: 0.3s;
          border-radius: 24px;
        }

        .toggle-slider:before {
          position: absolute;
          content: "";
          height: 18px;
          width: 18px;
          left: 3px;
          bottom: 3px;
          background-color: white;
          transition: 0.3s;
          border-radius: 50%;
        }

        input:checked + .toggle-slider {
          background-color: #4caf50;
        }

        input:checked + .toggle-slider:before {
          transform: translateX(24px);
        }

        input:disabled + .toggle-slider {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .toggle-label {
          font-weight: 500;
          font-size: 14px;
        }

        .info-button {
          background: none;
          border: none;
          cursor: pointer;
          font-size: 16px;
          padding: 4px;
          opacity: 0.7;
          transition: opacity 0.2s;
        }

        .info-button:hover {
          opacity: 1;
        }

        .size-estimate {
          margin-top: 8px;
          font-size: 12px;
          color: #666;
        }

        .estimate-label {
          margin-right: 4px;
        }

        .estimate-value {
          font-weight: 500;
          color: #333;
        }

        .chunks-info {
          margin-left: 8px;
          color: #888;
        }

        .encryption-info {
          margin-top: 12px;
          padding: 12px;
          background: rgba(255, 255, 255, 0.9);
          border-radius: 6px;
          font-size: 13px;
          line-height: 1.5;
        }

        .encryption-info p {
          margin: 0 0 8px 0;
        }

        .encryption-info ul {
          margin: 8px 0;
          padding-left: 20px;
        }

        .encryption-info li {
          margin: 4px 0;
        }

        .security-note {
          background: #fff3cd;
          padding: 8px 12px;
          border-radius: 4px;
          border-left: 3px solid #ffc107;
        }
      `}</style>
    </div>
  );
}
