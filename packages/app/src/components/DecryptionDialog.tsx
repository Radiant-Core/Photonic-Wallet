/**
 * Decryption Dialog Component
 *
 * Modal dialog for entering passphrase or key to decrypt content.
 * Local decryption - keys never leave the device.
 */

import { useState } from "react";
import { EncryptionProgress } from "./EncryptionProgress";
import type { EncryptionMode } from "../encryptionService";

export type DecryptionDialogProps = {
  /** Whether dialog is open */
  isOpen: boolean;
  /** Close dialog */
  onClose: () => void;
  /** Decryption mode */
  mode: EncryptionMode;
  /** Content name */
  contentName: string;
  /** Callback when user confirms decryption */
  onDecrypt: (key: string) => Promise<void>;
};

/**
 * Dialog for entering decryption credentials
 */
export function DecryptionDialog({
  isOpen,
  onClose,
  mode,
  contentName,
  onDecrypt,
}: DecryptionDialogProps) {
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleDecrypt = async () => {
    if (!key.trim()) {
      setError("Please enter the required key");
      return;
    }

    setIsDecrypting(true);
    setError(null);

    try {
      await onDecrypt(key);
      setKey("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Decryption failed");
    } finally {
      setIsDecrypting(false);
    }
  };

  const handleClose = () => {
    if (!isDecrypting) {
      setKey("");
      setError(null);
      onClose();
    }
  };

  return (
    <div className="decryption-dialog-overlay">
      <div className="decryption-dialog">
        <div className="dialog-header">
          <span className="header-icon">🔓</span>
          <h3>Decrypt Content</h3>
          <button
            className="close-btn"
            onClick={handleClose}
            disabled={isDecrypting}
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>

        <div className="dialog-content">
          <div className="content-info">
            <p className="content-name">{contentName}</p>
            <p className="security-notice">
              🔒 <strong>Local Decryption</strong> - Your key never leaves this device
            </p>
          </div>

          {mode === "passphrase" ? (
            <div className="input-section">
              <label className="input-label">
                Enter Passphrase
                <span className="required">*</span>
              </label>
              <div className="key-input-row">
                <input
                  type={showKey ? "text" : "password"}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="Enter the encryption passphrase..."
                  disabled={isDecrypting}
                  className="key-input"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleDecrypt();
                  }}
                />
                <button
                  className="toggle-visibility"
                  onClick={() => setShowKey(!showKey)}
                  type="button"
                  disabled={isDecrypting}
                  aria-label={showKey ? "Hide passphrase" : "Show passphrase"}
                >
                  {showKey ? "🙈" : "👁️"}
                </button>
              </div>
              <p className="input-hint">
                This is the same passphrase used when the content was encrypted.
              </p>
            </div>
          ) : (
            <div className="input-section">
              <label className="input-label">
                Private Key
                <span className="required">*</span>
              </label>
              <div className="key-input-row">
                <input
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="Enter your private key..."
                  disabled={isDecrypting}
                  className="key-input"
                />
              </div>
              <p className="input-hint">
                Your private key is required to unwrap the content encryption key.
              </p>
            </div>
          )}

          {isDecrypting && (
            <EncryptionProgress
              progress={{
                stage: "decrypting",
                loaded: 0,
                total: 100,
                percent: 50,
              }}
              operation="decrypting"
            />
          )}

          {error && <div className="error-message">{error}</div>}
        </div>

        <div className="dialog-footer">
          <button
            className="btn-cancel"
            onClick={handleClose}
            disabled={isDecrypting}
            type="button"
          >
            Cancel
          </button>
          <button
            className="btn-decrypt"
            onClick={handleDecrypt}
            disabled={isDecrypting || !key.trim()}
            type="button"
          >
            {isDecrypting ? (
              <>
                <span className="spinner" /> Decrypting...
              </>
            ) : (
              <>🔓 Decrypt</>
            )}
          </button>
        </div>
      </div>

      <style>{`
        .decryption-dialog-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          padding: 16px;
        }

        .decryption-dialog {
          background: white;
          border-radius: 12px;
          width: 100%;
          max-width: 480px;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
          overflow: hidden;
        }

        .dialog-header {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 16px 20px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
        }

        .header-icon {
          font-size: 24px;
        }

        .dialog-header h3 {
          flex: 1;
          margin: 0;
          font-size: 18px;
          font-weight: 600;
        }

        .close-btn {
          background: rgba(255, 255, 255, 0.2);
          border: none;
          color: white;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          cursor: pointer;
          font-size: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.2s;
        }

        .close-btn:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.3);
        }

        .close-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .dialog-content {
          padding: 20px;
        }

        .content-info {
          margin-bottom: 20px;
          padding: 12px;
          background: rgba(102, 126, 234, 0.05);
          border-radius: 8px;
        }

        .content-name {
          font-weight: 600;
          color: #333;
          margin: 0 0 8px 0;
        }

        .security-notice {
          margin: 0;
          font-size: 13px;
          color: #667eea;
        }

        .input-section {
          margin-bottom: 20px;
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

        .key-input-row {
          display: flex;
          gap: 8px;
        }

        .key-input {
          flex: 1;
          padding: 12px;
          border: 2px solid #e0e0e0;
          border-radius: 8px;
          font-size: 14px;
          transition: border-color 0.2s;
        }

        .key-input:focus {
          outline: none;
          border-color: #667eea;
          box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }

        .key-input:disabled {
          background: #f5f5f5;
        }

        .toggle-visibility {
          padding: 8px 12px;
          background: white;
          border: 2px solid #e0e0e0;
          border-radius: 8px;
          cursor: pointer;
          font-size: 18px;
          transition: all 0.2s;
        }

        .toggle-visibility:hover:not(:disabled) {
          border-color: #667eea;
        }

        .toggle-visibility:disabled {
          opacity: 0.5;
        }

        .input-hint {
          margin: 8px 0 0 0;
          font-size: 12px;
          color: #888;
        }

        .error-message {
          padding: 12px;
          background: rgba(220, 53, 69, 0.1);
          border-radius: 8px;
          color: #dc3545;
          font-size: 13px;
          margin-top: 12px;
        }

        .dialog-footer {
          display: flex;
          gap: 12px;
          padding: 16px 20px;
          background: #f8f9fa;
          border-top: 1px solid #e0e0e0;
        }

        .btn-cancel,
        .btn-decrypt {
          flex: 1;
          padding: 12px 20px;
          border-radius: 8px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
          font-size: 14px;
        }

        .btn-cancel {
          background: white;
          border: 2px solid #e0e0e0;
          color: #666;
        }

        .btn-cancel:hover:not(:disabled) {
          border-color: #999;
        }

        .btn-decrypt {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          border: none;
          color: white;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }

        .btn-decrypt:hover:not(:disabled) {
          opacity: 0.9;
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
        }

        .btn-decrypt:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .spinner {
          width: 16px;
          height: 16px;
          border: 2px solid rgba(255, 255, 255, 0.3);
          border-top-color: white;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </div>
  );
}
