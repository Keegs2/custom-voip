import { type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../utils/cn';
import { Select, type SelectProps } from './Select';

interface FormFieldBaseProps {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
  /** Wraps the field in a full-span grid cell */
  fullWidth?: boolean;
}

/** FormField's own props — never forwarded to the control. */
type OwnKeys = keyof FormFieldBaseProps | 'as';

type InputFieldProps = FormFieldBaseProps &
  InputHTMLAttributes<HTMLInputElement> & {
    as?: 'input';
  };

/**
 * The select branch is the themed `Select` (docker/ui/CLAUDE.md §8), never a
 * native <select>: `value` / `onChange(value)` / `options` instead of
 * <option> children. FormField supplies the id (for its label), the skin,
 * `invalid` (from `error`) and `required` (aria-required).
 *
 *   <FormField as="select" label="Product" value={product} onChange={setProduct}
 *              placeholder="Pick a product…" options={PRODUCT_OPTIONS} />
 */
type SelectFieldProps<V extends string> = FormFieldBaseProps &
  Omit<SelectProps<V>, 'className' | 'invalid' | 'required'> & {
    as: 'select';
  };

type TextareaFieldProps = FormFieldBaseProps &
  TextareaHTMLAttributes<HTMLTextAreaElement> & {
    as: 'textarea';
  };

type FormFieldProps<V extends string> = InputFieldProps | SelectFieldProps<V> | TextareaFieldProps;

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

const errorSkin =
  'border-[color:var(--t-danger-border)] focus:border-[color:var(--t-danger-fg)] focus:shadow-[0_0_0_3px_var(--t-danger-bg)]';

const labelBase = 'text-[0.68rem] font-semibold text-[color:var(--t-text-dim)] uppercase tracking-[0.04em]';

export function FormField<V extends string = string>(props: FormFieldProps<V>) {
  const { label, hint, error, required, className, fullWidth, as = 'input', ...rest } = props;

  const id = props.id ?? label.toLowerCase().replace(/\s+/g, '-');

  return (
    <div className={cn('flex flex-col gap-1.5', fullWidth && 'col-span-2', className)}>
      <label htmlFor={id} className={labelBase}>
        {label}
        {required && <span className="text-[color:var(--t-danger-fg)] ml-0.5">*</span>}
      </label>

      {as === 'select' ? (
        <Select<V>
          {...(rest as Omit<SelectFieldProps<V>, OwnKeys>)}
          id={id}
          // A <button> trigger: the Select draws its chevron on the right padding (px-3).
          className={cn(controlBase, 'cursor-pointer', error && errorSkin)}
          invalid={Boolean(error)}
          required={required}
        />
      ) : as === 'textarea' ? (
        <textarea
          id={id}
          className={cn(controlBase, 'resize-y min-h-[80px] h-auto py-2')}
          {...(rest as Omit<TextareaFieldProps, OwnKeys>)}
        />
      ) : (
        <input
          id={id}
          className={cn(controlBase, error && errorSkin)}
          aria-invalid={error ? true : undefined}
          {...(rest as Omit<InputFieldProps, OwnKeys>)}
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
