import { CaretDown, Check } from "@phosphor-icons/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useId } from "react";
import "./select-field.css";

type SelectOption = { value: string; label: string };

type SelectFieldProps = {
  value: string;
  options: SelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  labelledBy?: string;
  label?: string;
  id?: string;
};

export function SelectField({ value, options, onValueChange, disabled, placeholder, labelledBy, label, id }: SelectFieldProps) {
  const generatedId = useId();
  const triggerId = id ?? generatedId;
  const selectedOption = options.find((option) => option.value === value);
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger className="app-select-trigger" id={triggerId} disabled={disabled} data-placeholder={selectedOption ? undefined : ""} aria-labelledby={labelledBy ? `${labelledBy} ${triggerId}` : undefined} aria-label={label}>
        <span className="app-select-value">{selectedOption?.label ?? placeholder}</span>
        <span className="app-select-chevron"><CaretDown size={15} aria-hidden="true" /></span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="app-select-content" sideOffset={5} collisionPadding={12} aria-label={label} aria-labelledby={labelledBy}>
          <DropdownMenu.RadioGroup className="app-select-viewport" value={value} onValueChange={onValueChange}>
            {options.filter((option) => option.value !== "").map((option) => (
              <DropdownMenu.RadioItem className="app-select-item" key={option.value} value={option.value}>
                <span>{option.label}</span>
                <DropdownMenu.ItemIndicator className="app-select-indicator"><Check size={15} weight="bold" aria-hidden="true" /></DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
