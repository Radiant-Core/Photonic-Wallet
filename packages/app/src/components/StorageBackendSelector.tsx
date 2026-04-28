/**
 * Storage Backend Selector Component
 *
 * Allows choosing where encrypted content is stored:
 * - On-Chain (glyph): ≤512KB, self-sovereign, higher fees
 * - IPFS (ipfs): Any size, content-addressed, pinning required
 * - Arweave (arweave): Permanent, paid for large files
 * - Wallet Backend (backend): Private, instant, centralized
 */

import { useState } from "react";

const HAS_IPFS_KEY = !!(import.meta.env.VITE_NFT_STORAGE_TOKEN as string | undefined);

export type StorageBackend = "glyph" | "ipfs" | "arweave" | "backend";

export type StorageBackendSelectorProps = {
  /** Currently selected backend */
  backend: StorageBackend;
  /** Callback when backend changes */
  onChange: (backend: StorageBackend) => void;
  /** File size in bytes (for size limit checks) */
  fileSize?: number;
  /** Whether disabled */
  disabled?: boolean;
};

const GLYPH_MAX_SIZE = 512 * 1024; // 512 KB

const BACKEND_OPTIONS: {
  id: StorageBackend;
  label: string;
  icon: string;
  description: string;
  sizeLimit?: number;
  requiresApiKey?: boolean;
}[] = [
  {
    id: "glyph",
    label: "On-Chain",
    icon: "⛓️",
    description: "Encrypted data inscribed directly on Radiant. Self-sovereign, permanent, no external providers. Max 512KB.",
    sizeLimit: GLYPH_MAX_SIZE,
  },
  {
    id: "ipfs",
    label: "IPFS",
    icon: "🌐",
    description: "Content-addressed decentralized storage. Requires NFT.Storage API key for pinning.",
    requiresApiKey: true,
  },
  {
    id: "arweave",
    label: "Arweave",
    icon: "💎",
    description: "Permanent, immutable storage. Free for files ≤100KB via Irys node2.",
  },
  {
    id: "backend",
    label: "Wallet Backend",
    icon: "🔒",
    description: "Photonic Wallet's private backend. Fast and convenient but centralized.",
  },
];

/**
 * Storage backend selector with size validation
 */
export function StorageBackendSelector({
  backend,
  onChange,
  fileSize,
  disabled = false,
}: StorageBackendSelectorProps) {
  const [showHelp, setShowHelp] = useState(false);

  const isOverLimit = (sizeLimit?: number): boolean => {
    if (!fileSize || !sizeLimit) return false;
    return fileSize > sizeLimit;
  };

  const isApiKeyMissing = (requiresApiKey?: boolean): boolean =>
    !!requiresApiKey && !HAS_IPFS_KEY;

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="storage-backend-selector">
      <div className="selector-header">
        <label className="selector-label">Storage Location</label>
        <button
          className="help-toggle"
          onClick={() => setShowHelp(!showHelp)}
          type="button"
          aria-label={showHelp ? "Hide help" : "Show help"}
        >
          {showHelp ? "✕" : "?"}
        </button>
      </div>

      {showHelp && (
        <div className="help-panel">
          <p>
            Choose where the encrypted content is stored. The encrypted locator
            (pointer + metadata) is always stored on-chain regardless of this choice.
          </p>
        </div>
      )}

      <div className="backend-options">
        {BACKEND_OPTIONS.map((option) => {
          const overLimit = isOverLimit(option.sizeLimit);
          const missingKey = isApiKeyMissing(option.requiresApiKey);
          const isUnavailable = overLimit || missingKey;
          const isSelected = backend === option.id;

          return (
            <button
              key={option.id}
              className={`backend-option ${isSelected ? "selected" : ""} ${isUnavailable ? "disabled" : ""}`}
              onClick={() => !isUnavailable && !disabled && onChange(option.id)}
              disabled={disabled || isUnavailable}
              type="button"
              title={missingKey ? "VITE_NFT_STORAGE_TOKEN env var not set — IPFS unavailable" : undefined}
            >
              <span className="option-icon">{option.icon}</span>
              <div className="option-details">
                <span className="option-label">{option.label}</span>
                <span className="option-description">{option.description}</span>
                {option.sizeLimit && (
                  <span className={`size-limit ${overLimit ? "exceeded" : ""}`}>
                    Limit: {formatSize(option.sizeLimit)}
                    {overLimit && ` (your file is ${formatSize(fileSize!)})`}
                  </span>
                )}
                {missingKey && (
                  <span className="size-limit exceeded">API key not configured</span>
                )}
              </div>
              {isSelected && <span className="checkmark">✓</span>}
            </button>
          );
        })}
      </div>

      <style>{`
        .storage-backend-selector {
          margin: 16px 0;
        }

        .selector-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }

        .selector-label {
          font-size: 13px;
          font-weight: 600;
          color: #333;
        }

        .help-toggle {
          background: #f0f0f0;
          border: none;
          border-radius: 50%;
          width: 24px;
          height: 24px;
          cursor: pointer;
          font-size: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .help-toggle:hover {
          background: #e0e0e0;
        }

        .help-panel {
          background: #f8f9fa;
          border: 1px solid #e9ecef;
          border-radius: 6px;
          padding: 12px;
          margin-bottom: 12px;
          font-size: 12px;
          color: #666;
          line-height: 1.4;
        }

        .backend-options {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .backend-option {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          padding: 12px;
          background: white;
          border: 2px solid #e0e0e0;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.2s;
          text-align: left;
        }

        .backend-option:hover:not(:disabled) {
          border-color: #4caf50;
          background: rgba(76, 175, 80, 0.05);
        }

        .backend-option.selected {
          border-color: #4caf50;
          background: rgba(76, 175, 80, 0.1);
        }

        .backend-option.disabled {
          opacity: 0.5;
          cursor: not-allowed;
          background: #f5f5f5;
        }

        .option-icon {
          font-size: 20px;
          flex-shrink: 0;
        }

        .option-details {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .option-label {
          font-weight: 600;
          font-size: 14px;
          color: #333;
        }

        .option-description {
          font-size: 12px;
          color: #666;
          line-height: 1.3;
        }

        .size-limit {
          font-size: 11px;
          color: #888;
          font-weight: 500;
        }

        .size-limit.exceeded {
          color: #dc3545;
          font-weight: 600;
        }

        .checkmark {
          color: #4caf50;
          font-weight: bold;
          font-size: 16px;
          flex-shrink: 0;
        }
      `}</style>
    </div>
  );
}
