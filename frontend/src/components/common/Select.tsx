interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
  id?: string;
}

export function Select({ options, value, onChange, label, disabled = false, id }: SelectProps) {
  return (
    <div class="select-wrapper">
      {label && <label class="form-field__label" for={id}>{label}</label>}
      <div class="select-container">
        <select
          id={id}
          class="select-input"
          value={value}
          onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
          disabled={disabled}
        >
          {options.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <svg class="select-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="4,6 8,10 12,6" />
        </svg>
      </div>
    </div>
  );
}
