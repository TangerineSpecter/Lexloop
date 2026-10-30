'use client';

import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import styles from './styled-select.module.css';

export type StyledSelectOption = { value: string; label: string };

/** A small listbox for the short, fixed option sets used inside the dashboard. */
export function StyledSelect({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: string;
  options: StyledSelectOption[];
  onChange: (value: string) => void;
  label: string;
  className?: string;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef('');
  const typeaheadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(
      0,
      options.findIndex((option) => option.value === value),
    ),
  );
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  const measure = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gutter = 10;
    const width = Math.min(Math.max(rect.width, 190), window.innerWidth - gutter * 2);
    const left = Math.max(gutter, Math.min(rect.left, window.innerWidth - width - gutter));
    const below = window.innerHeight - rect.bottom - gutter;
    const above = rect.top - gutter;
    const maxHeight = Math.max(120, Math.min(260, Math.max(below, above) - 8));
    const top =
      below >= Math.min(220, maxHeight) || below >= above
        ? rect.bottom + 6
        : Math.max(gutter, rect.top - maxHeight - 6);
    setPosition({ left, top, width, maxHeight });
  };

  const focusActiveOption = (index: number) => {
    setActiveIndex(index);
    requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>(`[data-option-index="${index}"]`)?.focus();
    });
  };

  const openMenu = (
    index = Math.max(
      0,
      options.findIndex((option) => option.value === value),
    ),
  ) => {
    setActiveIndex(index);
    setOpen(true);
    requestAnimationFrame(() => {
      measure();
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    const reposition = () => measure();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !position) return;
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`)
      ?.focus({ preventScroll: true });
  }, [activeIndex, open, position]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [open]);

  useEffect(
    () => () => {
      if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
    },
    [],
  );

  const choose = (option: StyledSelectOption) => {
    onChange(option.value);
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      focusActiveOption((activeIndex + delta + options.length) % options.length);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusActiveOption(event.key === 'Home' ? 0 : options.length - 1);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) choose(option);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      typeaheadRef.current += event.key.toLocaleLowerCase();
      if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
      typeaheadTimerRef.current = setTimeout(() => (typeaheadRef.current = ''), 700);
      const match = options.findIndex((option) =>
        option.label.toLocaleLowerCase().startsWith(typeaheadRef.current),
      );
      if (match >= 0) {
        event.preventDefault();
        focusActiveOption(match);
      }
    }
  };

  return (
    <div className={[styles.root, className].filter(Boolean).join(' ')}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const selectedIndex = Math.max(
              0,
              options.findIndex((option) => option.value === value),
            );
            openMenu(
              event.key === 'ArrowUp'
                ? (selectedIndex - 1 + options.length) % options.length
                : selectedIndex,
            );
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (!open) openMenu();
          }
        }}
      >
        <span>{selected?.label ?? '请选择'}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && position && (
        <div
          ref={menuRef}
          id={id}
          className={styles.menu}
          role="listbox"
          aria-label={label}
          style={{
            left: position.left,
            top: position.top,
            width: position.width,
            maxHeight: position.maxHeight,
          }}
          onKeyDown={handleOptionKeyDown}
        >
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              data-option-index={index}
              data-option-value={option.value}
              tabIndex={index === activeIndex ? 0 : -1}
              className={styles.option}
              onFocus={() => setActiveIndex(index)}
              onClick={() => choose(option)}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={16} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
