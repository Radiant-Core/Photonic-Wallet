/**
 * Encryption Progress Component
 *
 * Visual progress indicator for chunked encryption/decryption operations.
 * Shows current stage, progress bar, and percentage.
 */

import { useRef, useEffect } from "react";
import type { EncryptionProgress as ProgressType } from "../encryptionService";

export type EncryptionProgressProps = {
  /** Current progress state */
  progress: ProgressType | null;
  /** Operation type */
  operation: "encrypting" | "decrypting" | "uploading" | "downloading";
  /** Whether operation is complete */
  complete?: boolean;
  /** Error message if failed */
  error?: string | null;
};

/**
 * Progress indicator for encryption operations
 */
export function EncryptionProgress({
  progress,
  operation,
  complete = false,
  error,
}: EncryptionProgressProps) {
  const getStageIcon = (stage: string): string => {
    const icons: Record<string, string> = {
      reading: "📖",
      encrypting: "🔐",
      decrypting: "🔓",
      uploading: "📤",
      downloading: "📥",
      building: "🏗️",
      verifying: "✓",
      complete: "✅",
    };
    return icons[stage] || "⏳";
  };

  const getStageLabel = (stage: string): string => {
    const labels: Record<string, string> = {
      reading: "Reading file...",
      encrypting: "Encrypting content...",
      decrypting: "Decrypting content...",
      uploading: "Uploading to storage...",
      downloading: "Downloading from storage...",
      building: "Building metadata...",
      verifying: "Verifying integrity...",
      complete: "Complete!",
    };
    return labels[stage] || stage;
  };

  const getOperationTitle = (op: string): string => {
    const titles: Record<string, string> = {
      encrypting: "Encrypting Content",
      decrypting: "Decrypting Content",
      uploading: "Uploading Content",
      downloading: "Downloading Content",
    };
    return titles[op] || "Processing";
  };

  if (error) {
    return (
      <div className="encryption-progress error">
        <div className="progress-header">
          <span className="status-icon">❌</span>
          <span className="operation-title">Error</span>
        </div>
        <div className="error-message">{error}</div>

        <style>{`
          .encryption-progress.error {
            padding: 16px;
            background: rgba(220, 53, 69, 0.1);
            border-radius: 8px;
            border-left: 4px solid #dc3545;
          }

          .progress-header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
          }

          .status-icon {
            font-size: 20px;
          }

          .operation-title {
            font-weight: 600;
            color: #dc3545;
          }

          .error-message {
            color: #666;
            font-size: 13px;
          }
        `}</style>
      </div>
    );
  }

  if (complete) {
    return (
      <div className="encryption-progress complete">
        <div className="progress-header">
          <span className="status-icon">✅</span>
          <span className="operation-title">{getOperationTitle(operation)}</span>
        </div>
        <div className="success-message">Operation completed successfully</div>

        <style>{`
          .encryption-progress.complete {
            padding: 16px;
            background: rgba(40, 167, 69, 0.1);
            border-radius: 8px;
            border-left: 4px solid #28a745;
          }

          .progress-header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
          }

          .status-icon {
            font-size: 20px;
          }

          .operation-title {
            font-weight: 600;
            color: #28a745;
          }

          .success-message {
            color: #666;
            font-size: 13px;
          }
        `}</style>
      </div>
    );
  }

  if (!progress) {
    return (
      <div className="encryption-progress idle">
        <div className="progress-header">
          <span className="status-icon">⏳</span>
          <span className="operation-title">{getOperationTitle(operation)}</span>
        </div>
        <div className="waiting-message">Waiting to start...</div>

        <style>{`
          .encryption-progress.idle {
            padding: 16px;
            background: rgba(0, 0, 0, 0.02);
            border-radius: 8px;
          }

          .progress-header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
          }

          .status-icon {
            font-size: 20px;
          }

          .operation-title {
            font-weight: 600;
            color: #333;
          }

          .waiting-message {
            color: #888;
            font-size: 13px;
          }
        `}</style>
      </div>
    );
  }

  const { stage, loaded, total, percent } = progress;
  const barContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    barContainerRef.current?.style.setProperty("--progress", `${percent}%`);
  }, [percent]);

  return (
    <div className="encryption-progress active">
      <div className="progress-header">
        <span className="stage-icon">{getStageIcon(stage)}</span>
        <span className="stage-label">{getStageLabel(stage)}</span>
        <span className="percent-label">{Math.round(percent)}%</span>
      </div>

      <div className="progress-bar-container" ref={barContainerRef}>
        <div className="progress-bar" />
      </div>

      <div className="progress-details">
        <span className="bytes-processed">
          {formatBytes(loaded)} / {formatBytes(total)}
        </span>
        <span className="stage-tag">{stage}</span>
      </div>

      {stage === "encrypting" && (
        <div className="encryption-note">
          🔒 Content is being encrypted locally - no data leaves your device
        </div>
      )}

      <style>{`
        .encryption-progress.active {
          padding: 16px;
          background: rgba(76, 175, 80, 0.05);
          border-radius: 8px;
          border: 1px solid rgba(76, 175, 80, 0.2);
        }

        .progress-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
        }

        .stage-icon {
          font-size: 18px;
        }

        .stage-label {
          flex: 1;
          font-weight: 500;
          color: #333;
        }

        .percent-label {
          font-weight: 600;
          color: #4caf50;
          font-size: 14px;
        }

        .progress-bar-container {
          height: 8px;
          background: rgba(0, 0, 0, 0.1);
          border-radius: 4px;
          overflow: hidden;
          margin-bottom: 8px;
        }

        .progress-bar {
          height: 100%;
          width: var(--progress, 0%);
          background: linear-gradient(90deg, #4caf50, #81c784);
          border-radius: 4px;
          transition: width 0.3s ease;
        }

        .progress-details {
          display: flex;
          justify-content: space-between;
          font-size: 12px;
          color: #666;
        }

        .bytes-processed {
          font-family: monospace;
        }

        .stage-tag {
          text-transform: uppercase;
          font-size: 10px;
          padding: 2px 6px;
          background: rgba(0, 0, 0, 0.05);
          border-radius: 3px;
        }

        .encryption-note {
          margin-top: 12px;
          padding: 8px 12px;
          background: rgba(76, 175, 80, 0.1);
          border-radius: 6px;
          font-size: 12px;
          color: #2e7d32;
        }
      `}</style>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
