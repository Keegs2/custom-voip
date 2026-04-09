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
  'text-[0.92rem] px-3 py-[9px] rounded-lg w-full',
  'border border-[#2a2f45] bg-[#1e2130] text-[#e2e8f0]',
  'outline-none transition-[border-color,box-shadow] duration-150',
  'focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.28)]',
  'placeholder:text-[#718096]',
  'disabled:opacity-50 disabled:cursor-not-allowed',
].join(' ');

export function FormField(props: FormFieldProps) {
  const { label, hint, error, required, className, fullWidth, as = 'input', ...rest } = props;

  const id = (rest as { id?: string }).id ?? label.toLowerCase().replace(/\s+/g, '-');
  const labelClass = 'text-[0.7rem] font-bold text-[#718096] uppercase tracking-[0.7px]';

  return (
    <div className={cn('flex flex-col gap-[5px]', fullWidth && 'col-span-2', className)}>
      <label htmlFor={id} className={labelClass}>
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </label>

      {as === 'select' ? (
        <select
          id={id}
          className={cn(controlBase, 'cursor-pointer')}
          {...(rest as SelectHTMLAttributes<HTMLSelectElement>)}
        >
          {(props as SelectFieldProps).children}
        </select>
      ) : as === 'textarea' ? (
        <textarea
          id={id}
          className={cn(controlBase, 'resize-y min-h-[80px]')}
          {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)}
        />
      ) : (
        <input
          id={id}
          className={cn(controlBase, error && 'border-red-500/60')}
          {...(rest as InputHTMLAttributes<HTMLInputElement>)}
        />
      )}

      {hint && !error && (
        <p className="text-[0.72rem] text-[#718096]">{hint}</p>
      )}
      {error && (
        <p className="text-[0.72rem] text-red-400">{error}</p>
      )}
    </div>
  );
}
