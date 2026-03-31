import { useState, useCallback, useEffect, useRef } from "react";
import type { IpcResponse, ContactSuggestion } from "../../shared/types";

interface AddressInputProps {
  label: string;
  value: string[];
  onChange: (addresses: string[]) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Map of lowercase email → display name. When provided, chips show names instead of bare emails. */
  nameMap?: Map<string, string>;
  /** Called when Tab is pressed so the parent can move focus to the next field */
  onTab?: () => void;
  /** External ref to allow parent to programmatically focus this input */
  inputRef?: React.RefObject<HTMLInputElement>;
  /** Identifier for this field (e.g., "to", "cc", "bcc") — enables drag-and-drop between fields */
  fieldId?: string;
  /** Called when a chip from another field is dropped onto this field */
  onChipDrop?: (email: string, sourceField: string) => void;
  /** Called when a chip drag starts (parent can use this to reveal hidden fields) */
  onChipDragStart?: () => void;
  /** Called when a contact is selected from autocomplete, so the parent can track the name mapping */
  onSuggestionSelected?: (suggestion: ContactSuggestion) => void;
}

export function AddressInput({
  label,
  value,
  onChange,
  placeholder,
  autoFocus,
  nameMap,
  onTab,
  inputRef: externalRef,
  fieldId,
  onChipDrop,
  onChipDragStart,
  onSuggestionSelected,
}: AddressInputProps) {
  const [inputValue, setInputValue] = useState("");
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const internalRef = useRef<HTMLInputElement>(null);
  const inputRef = externalRef ?? internalRef;
  const suggestionsRef = useRef<HTMLDivElement>(null);
  // Track when Tab navigation is handling the value, so handleBlur doesn't duplicate it
  const isTabNavigating = useRef(false);
  // Track which chips have been double-clicked to reveal their email
  const [revealedChips, setRevealedChips] = useState<Set<string>>(new Set());
  // Drag-and-drop state
  const [isDragOver, setIsDragOver] = useState(false);

  // Debounced contact search
  useEffect(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const response = (await window.api.contacts.suggest(trimmed, 8)) as IpcResponse<
          ContactSuggestion[]
        >;
        if (response.success) {
          // Filter out already-added addresses
          const filtered = response.data.filter(
            (s) => !value.some((v) => v.toLowerCase() === s.email.toLowerCase()),
          );
          setSuggestions(filtered);
          setShowSuggestions(filtered.length > 0);
          setSelectedIndex(-1);
        }
      } catch {
        // Autocomplete is non-critical
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [inputValue, value]);

  // Scroll selected suggestion into view
  useEffect(() => {
    if (selectedIndex >= 0 && suggestionsRef.current) {
      const el = suggestionsRef.current.children[selectedIndex] as HTMLElement;
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const selectSuggestion = useCallback(
    (suggestion: ContactSuggestion, refocusInput = true) => {
      if (!value.some((v) => v.toLowerCase() === suggestion.email.toLowerCase())) {
        onChange([...value, suggestion.email]);
      }
      onSuggestionSelected?.(suggestion);
      setInputValue("");
      setSuggestions([]);
      setShowSuggestions(false);
      setSelectedIndex(-1);
      if (refocusInput) {
        inputRef.current?.focus();
      }
    },
    [value, onChange, inputRef, onSuggestionSelected],
  );

  const addTypedValue = useCallback(() => {
    const email = inputValue.trim();
    if (email && !value.some((v) => v.toLowerCase() === email.toLowerCase())) {
      onChange([...value, email]);
    }
    setInputValue("");
  }, [inputValue, value, onChange]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Autocomplete navigation
    if (showSuggestions && suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, suggestions.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowSuggestions(false);
        setSelectedIndex(-1);
        return;
      }
      if ((e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) && selectedIndex >= 0) {
        e.preventDefault();
        const isTab = e.key === "Tab";
        selectSuggestion(suggestions[selectedIndex], !isTab);
        if (isTab && onTab) {
          isTabNavigating.current = true;
          onTab();
        }
        return;
      }
    }

    // Default address input behavior
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTypedValue();
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      addTypedValue();
      if (onTab) {
        isTabNavigating.current = true;
        onTab();
      }
    } else if (e.key === "Backspace" && inputValue === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const handleRemove = (email: string) => {
    onChange(value.filter((e) => e !== email));
  };

  const handleBlur = () => {
    setShowSuggestions(false);
    setSelectedIndex(-1);
    if (!isTabNavigating.current) {
      addTypedValue();
    }
    isTabNavigating.current = false;
  };

  const toggleChipReveal = (email: string) => {
    setRevealedChips((prev) => {
      const next = new Set(prev);
      if (next.has(email)) {
        next.delete(email);
      } else {
        next.add(email);
      }
      return next;
    });
  };

  /** Resolve display text for a chip based on nameMap and reveal state */
  const chipDisplay = (email: string): { text: string; hasName: boolean } => {
    if (!nameMap) return { text: email, hasName: false };
    const name = nameMap.get(email.toLowerCase());
    if (!name) return { text: email, hasName: false };
    if (revealedChips.has(email)) {
      return { text: `${name} <${email}>`, hasName: true };
    }
    return { text: name, hasName: true };
  };

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!fieldId || !e.dataTransfer.types.includes("application/x-address-chip")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setIsDragOver(true);
    },
    [fieldId],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only reset when leaving the container (not when entering a child)
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      if (!fieldId || !onChipDrop) return;
      try {
        const data = JSON.parse(e.dataTransfer.getData("application/x-address-chip"));
        if (data.sourceField !== fieldId) {
          onChipDrop(data.email, data.sourceField);
        }
      } catch {
        /* invalid drag data */
      }
    },
    [fieldId, onChipDrop],
  );

  return (
    <div
      data-testid={`address-input-${label.toLowerCase()}`}
      className={`relative flex items-center gap-2 py-1.5 border-b transition-colors ${
        isDragOver
          ? "border-blue-400 dark:border-blue-500 bg-blue-50 dark:bg-blue-900/20"
          : "border-gray-200 dark:border-gray-700/50"
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <label className="w-10 text-sm text-gray-500 dark:text-gray-400 flex-shrink-0">{label}</label>
      <div className="flex-1 flex flex-wrap items-center">
        {value.map((email, i) => {
          const { text, hasName } = chipDisplay(email);
          return (
            <span
              key={email}
              draggable={!!fieldId}
              onDragStart={
                fieldId
                  ? (e) => {
                      e.dataTransfer.setData(
                        "application/x-address-chip",
                        JSON.stringify({ email, sourceField: fieldId }),
                      );
                      e.dataTransfer.effectAllowed = "move";
                      onChipDragStart?.();
                    }
                  : undefined
              }
              className={`group/chip relative inline-flex items-center text-sm text-gray-900 dark:text-gray-100 whitespace-nowrap rounded-full pl-1.5 pr-5 py-0.5 -my-0.5 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors ${hasName ? "cursor-pointer" : ""} ${fieldId ? "cursor-grab active:cursor-grabbing" : ""}`}
              data-testid="address-chip"
              role={hasName ? "button" : undefined}
              tabIndex={hasName ? 0 : undefined}
              onDoubleClick={hasName ? () => toggleChipReveal(email) : undefined}
              onKeyDown={
                hasName
                  ? (e: React.KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleChipReveal(email);
                      }
                    }
                  : undefined
              }
              title={
                fieldId
                  ? "Drag to move between To, Cc, Bcc"
                  : hasName
                    ? revealedChips.has(email)
                      ? "Double-click to hide email"
                      : "Double-click to show email"
                    : undefined
              }
            >
              {text}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemove(email);
                }}
                className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 opacity-0 group-hover/chip:opacity-100 z-10"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
              {(i < value.length - 1 || inputValue !== "") && (
                <span className="ml-0.5 text-gray-400 dark:text-gray-500 select-none group-hover/chip:invisible">
                  ·
                </span>
              )}
            </span>
          );
        })}
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={value.length === 0 ? placeholder : ""}
          autoFocus={autoFocus}
          className="flex-1 min-w-[120px] text-sm dark:text-gray-100 dark:placeholder-gray-400 bg-transparent"
          style={{ outline: "none", border: "none", boxShadow: "none" }}
        />
      </div>

      {/* Autocomplete dropdown */}
      {showSuggestions && suggestions.length > 0 && (
        <div
          ref={suggestionsRef}
          data-testid="autocomplete-dropdown"
          className="absolute left-[calc(2.5rem+0.5rem)] top-full mt-0.5 w-[calc(100%-2.5rem-0.5rem)] bg-gray-800 border border-gray-700 rounded-lg shadow-xl shadow-black/50 max-h-60 overflow-y-auto z-50"
          onMouseDown={(e) => e.preventDefault()}
        >
          {suggestions.map((suggestion, index) => (
            <div
              key={suggestion.email}
              className={`px-4 py-2.5 cursor-pointer text-sm flex items-center justify-between gap-4 ${
                index === selectedIndex ? "bg-gray-700" : "hover:bg-gray-700/50"
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                selectSuggestion(suggestion);
              }}
              onMouseEnter={() => setSelectedIndex(index)}
              data-testid="autocomplete-suggestion"
            >
              <span className="text-gray-100 truncate">{suggestion.name || suggestion.email}</span>
              {suggestion.name && (
                <span className="text-gray-500 text-sm truncate flex-shrink-0">
                  {suggestion.email}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
