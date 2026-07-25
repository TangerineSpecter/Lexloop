import { cloneElement, type ReactElement } from 'react';

type TooltipProps = {
  children: ReactElement<{ 'data-tooltip'?: string }>;
  label: string;
};

/**
 * Adds the shared, CSS-rendered tooltip to one interactive child without
 * introducing a wrapper that could change the surrounding layout.
 */
export function Tooltip({ children, label }: TooltipProps) {
  return cloneElement(children, { 'data-tooltip': label });
}
