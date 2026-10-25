import { type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../utils/cn';

interface FormFieldBaseProps {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
  /** Wraps the field in a full-span grid cell */
  fullWidth?: boolean;
}

type InputFieldProps = FormFieldBaseProps &
  InputHTMLAttributes<HTMLInputElement> & {
    as?: 'input';
  };

type SelectFieldProps = FormFieldBaseProps &
  SelectHTMLAttributes<HTMLSelectElement> & {
    as: 'select';
    children: React.ReactNode;
  };

type TextareaFieldProps = FormFieldBaseProps &
  TextareaHTMLAttributes<HTMLTextAreaElement> & {
    as: 'textarea';
  };

type FormFieldProps = InputFieldProps | SelectFieldProps | TextareaFieldProps;

// Theme tokens only (src/styles/theme.css) — a field well in either theme.
const controlBase = [
  'text-sm px-3 py-2 rounded-lg w-full h-9',
  'border border-[color:var(--t-field-border)] bg-[color:var(--t-field-bg)] text-[color:var(--t-text)]',
  'outline-none transition-all duration-150',
  'hover:border-[color:var(--t-field-border-hover)]',
  'focus:border-[color:var(--t-focus)] focus:shadow-[var(--t-focus-halo)]',
  'placeholder:text-[color:var(--t-field-placeholder)]',
  'disabled:bg-[color:var(--t-field-disabled-bg)] disabled:text-[color:var(--t-text-faint)] disabled:cursor-not-allowed',
].join(' ');

const labelBase = 'text-[0.68rem] font-semibold text-[color:var(--t-text-dim)] uppercase tracking-[0.04em]';

export function FormField(props: FormFieldProps) {
  const { label, hint, error, required, className, fullWidth, as = 'input', ...rest } = props;

  const id = (rest as { id?: string }).id ?? label.toLowerCase().replace(/\s+/g, '-');

  return (
    <div className={cn('flex flex-col gap-1.5', fullWidth && 'col-span-2', className)}>
      <label htmlFor={id} className={labelBase}>
        {label}
        {required && <span className="text-[color:var(--t-danger-fg)] ml-0.5">*</span>}
      </label>

      {as === 'select' ? (
        <select
          id={id}
          className={cn(controlBase, 'cursor-pointer h-9')}
          {...(rest as SelectHTMLAttributes<HTMLSelectElement>)}
        >
          {(props as SelectFieldProps).children}
        </select>
      ) : as === 'textarea' ? (
        <textarea
          id={id}
          className={cn(controlBase, 'resize-y min-h-[80px] h-auto py-2')}
          {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)}
        />
      ) : (
        <input
          id={id}
          className={cn(
            controlBase,
            error && 'border-[color:var(--t-danger-border)] focus:border-[color:var(--t-danger-fg)] focus:shadow-[0_0_0_3px_var(--t-danger-bg)]',
          )}
          aria-invalid={error ? true : undefined}
          {...(rest as InputHTMLAttributes<HTMLInputElement>)}
        />
      )}

      {hint && !error && (
        <p className="text-xs text-[color:var(--t-text-dim)]">{hint}</p>
      )}
      {error && (
        <p className="text-xs text-[color:var(--t-danger-fg)]">{error}</p>
      )}
    </div>
  );
}
