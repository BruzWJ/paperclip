import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DatePicker, DateRangePicker, DateTimePicker } from "@/components/patterns/DatePicker";

function DatePickerShowcase() {
  const [date, setDate] = useState("2026-06-26");
  const [range, setRange] = useState({ from: "2026-06-01", to: "2026-06-26" });
  const [dateTime, setDateTime] = useState("2026-06-26T09:30");

  return (
    <div className="grid max-w-3xl gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Single date</CardTitle>
          <CardDescription>Calendar popover for date-only values.</CardDescription>
        </CardHeader>
        <CardContent>
          <DatePicker value={date} onValueChange={setDate} ariaLabel="Target date" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Date range</CardTitle>
          <CardDescription>One calendar surface for a complete reporting window.</CardDescription>
        </CardHeader>
        <CardContent>
          <DateRangePicker value={range} onValueChange={setRange} ariaLabel="Reporting range" />
        </CardContent>
      </Card>
      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle>Date and time</CardTitle>
          <CardDescription>Calendar selection paired with shadcn&apos;s native time input.</CardDescription>
        </CardHeader>
        <CardContent>
          <DateTimePicker
            value={dateTime}
            onValueChange={setDateTime}
            dateAriaLabel="Reminder date"
            timeAriaLabel="Reminder time"
          />
        </CardContent>
      </Card>
    </div>
  );
}

const meta = {
  title: "Patterns/Date picker",
  component: DatePickerShowcase,
} satisfies Meta<typeof DatePickerShowcase>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
