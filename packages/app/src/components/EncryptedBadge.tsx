/**
 * Encrypted Badge Component
 *
 * Displays a lock icon and encryption status for tokens in the wallet.
 */

export type EncryptedBadgeProps = {
  /** Badge size */
  size?: "small" | "medium" | "large";
  /** Show additional details */
  showDetails?: boolean;
  /** Number of recipients (for recipient mode) */
  recipientCount?: number;
  /** Whether passphrase protected */
  passphraseProtected?: boolean;
  /** Click handler */
  onClick?: () => void;
};

/**
 * Badge showing encryption status
 */
export function EncryptedBadge({
  size = "medium",
  showDetails = false,
  recipientCount,
  passphraseProtected,
  onClick,
}: EncryptedBadgeProps) {
  const sizeClasses: Record<string, string> = {
    small: "size-small",
    medium: "size-medium",
    large: "size-large",
  };

  const getTooltip = (): string => {
    if (passphraseProtected) {
      return "🔐 Passphrase-protected encrypted content";
    }
    if (recipientCount && recipientCount > 0) {
      return `🔐 Encrypted for ${recipientCount} recipient${recipientCount > 1 ? "s" : ""}`;
    }
    return "🔐 Encrypted content";
  };

  return (
    <span
      className={`encrypted-badge ${sizeClasses[size]} ${onClick ? "clickable" : ""}`}
      onClick={onClick}
      title={getTooltip()}
    >
      <span className="lock-icon">🔒</span>
      {showDetails && (
        <span className="badge-text">
          {passphraseProtected
            ? "Passphrase"
            : recipientCount
            ? `${recipientCount} recipient${recipientCount > 1 ? "s" : ""}`
            : "Encrypted"}
        </span>
      )}

      <style>{`
        .encrypted-badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          border-radius: 20px;
          font-weight: 600;
          white-space: nowrap;
          transition: all 0.2s;
        }

        .encrypted-badge.size-small {
          font-size: 12px;
          padding: 2px 6px;
        }

        .encrypted-badge.size-medium {
          font-size: 14px;
          padding: 4px 8px;
        }

        .encrypted-badge.size-large {
          font-size: 16px;
          padding: 6px 12px;
        }

        .encrypted-badge.clickable {
          cursor: pointer;
        }

        .encrypted-badge:not(.clickable) {
          cursor: default;
        }

        .encrypted-badge:hover {
          transform: scale(1.05);
          box-shadow: 0 2px 8px rgba(102, 126, 234, 0.4);
        }

        .lock-icon {
          font-size: 0.9em;
        }

        .badge-text {
          font-size: 0.85em;
        }
      `}</style>
    </span>
  );
}

/**
 * Compact lock icon for token lists
 */
export function LockIcon({
  size = 16,
  color = "#667eea",
}: {
  size?: number;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
