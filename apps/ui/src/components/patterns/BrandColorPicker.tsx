import { useCallback, useRef } from "react";

import {
  ColorPicker,
  ColorPickerAlpha,
  ColorPickerEyeDropper,
  ColorPickerFormat,
  ColorPickerHue,
  ColorPickerOutput,
  ColorPickerSelection,
  type ColorPickerProps,
} from "@/components/kibo-ui/color-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface BrandColorPickerProps {
  value: string;
  fallbackValue: string;
  onChange: (value: string) => void;
}

export interface HexColorPickerProps {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}

function channelHex(channel: number) {
  return Math.max(0, Math.min(255, Math.round(channel)))
    .toString(16)
    .padStart(2, "0");
}

function ColorPickerSession({ value, onChange, ariaLabel }: HexColorPickerProps) {
  const hasUserInteracted = useRef(false);
  const handlePickerChange = useCallback<NonNullable<ColorPickerProps["onChange"]>>(
    (rgba) => {
      if (!hasUserInteracted.current) return;

      const [red = 0, green = 0, blue = 0] = rgba as number[];
      onChange(`#${channelHex(red)}${channelHex(green)}${channelHex(blue)}`);
    },
    [onChange],
  );

  return (
    <ColorPicker
      className="max-w-sm rounded-md border bg-background p-4 shadow-sm"
      defaultValue={value}
      onChange={handlePickerChange}
      onPointerDownCapture={() => {
        hasUserInteracted.current = true;
      }}
      onKeyDownCapture={() => {
        hasUserInteracted.current = true;
      }}
    >
      <ColorPickerSelection className="h-40" aria-label={`${ariaLabel} saturation and lightness`} />
      <div className="flex items-center gap-4">
        <ColorPickerEyeDropper aria-label={`Pick ${ariaLabel.toLowerCase()} from the screen`} />
        <div className="grid w-full gap-1">
          <ColorPickerHue aria-label={`${ariaLabel} hue`} />
          <ColorPickerAlpha aria-label={`${ariaLabel} opacity`} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <ColorPickerOutput aria-label={`${ariaLabel} format`} />
        <ColorPickerFormat />
      </div>
    </ColorPicker>
  );
}

/** Hex color contract backed by Kibo's full color-picker composition. */
export function HexColorPicker({ value, onChange, ariaLabel }: HexColorPickerProps) {
  return <ColorPickerSession value={value} onChange={onChange} ariaLabel={ariaLabel} />;
}

/** Company brand-color contract wrapped around Kibo's full color picker. */
export function BrandColorPicker({ value, fallbackValue, onChange }: BrandColorPickerProps) {
  const pickerValue = /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallbackValue;

  return (
    <div className="space-y-2">
      <HexColorPicker value={pickerValue} onChange={onChange} ariaLabel="Brand color" />
      <div className="flex items-center gap-2">
        <Input
          aria-label="Brand color hex value"
          type="text"
          value={value}
          onChange={(event) => {
            const nextValue = event.target.value;
            if (nextValue === "" || /^#[0-9a-fA-F]{0,6}$/.test(nextValue)) {
              onChange(nextValue);
            }
          }}
          placeholder="Auto"
          className="w-28 font-mono"
        />
        {value ? (
          <Button size="sm" variant="ghost" onClick={() => onChange("")}>
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}
