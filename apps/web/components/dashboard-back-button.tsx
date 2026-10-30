'use client';

import { ArrowLeft } from 'lucide-react';
import styles from './dashboard-back-button.module.css';

export function DashboardBackButton({
  children,
  onClick,
  className,
}: {
  children: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      className={['dashboard-return-button', styles.back, className].filter(Boolean).join(' ')}
      type="button"
      onClick={onClick}
    >
      <ArrowLeft size={17} aria-hidden="true" />
      <span>{children}</span>
    </button>
  );
}
