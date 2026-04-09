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

const controlBase = [
  'text-sm px-3 py-2 rounded-lg w-full h-9',
  'border border-[#2a2f45] bg-[#1e2130] text-[#e2e8f0]',
  'outline-none transition-all duration-150',
  'focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.2)]',
  'placeholder:text-[#4a5568]',
  'disabled:opacity-50 disabled:cursor-not-allowed',
].join(' ');

const labelBase = 'text-[0.68rem] font-bold text-[#4a5568] uppercase tracking-[0.8px]';

export function FormField(props: FormFieldProps) {
  const { label, hint, error, required, className, fullWidth, as = 'input', ...rest } = props;

  const id = (rest as { id?: string }).id ?? label.toLowerCase().replace(/\s+/g, '-');

  return (
    <div className={cn('flex flex-col gap-1.5', fullWidth && 'col-span-2', className)}>
      <label htmlFor={id} className={labelBase}>
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
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
          className={cn(controlBase, error && 'border-red-500/60 focus:shadow-[0_0_0_3px_rgba(239,68,68,0.2)]')}
          {...(rest as InputHTMLAttributes<HTMLInputElement>)}
        />
      )}

      {hint && !error && (
        <p className="text-xs text-[#4a5568]">{hint}</p>
      )}
      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}
    </div>
  );
}
