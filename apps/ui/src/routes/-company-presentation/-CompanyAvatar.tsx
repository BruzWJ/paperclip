import { Avatar as DiceBearAvatar, Style } from "@dicebear/core";
import glassDefinition from "@dicebear/styles/glass.json" with { type: "json" };
import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

const glassStyle = new Style(glassDefinition);

export function createCompanyAvatarDataUri(companyName: string, brandColor?: string | null) {
  const normalizedBrandColor = brandColor?.trim() || undefined;

  return new DiceBearAvatar(glassStyle, {
    seed: companyName.trim().toLowerCase() || "paperclip-company",
    borderRadius: 0,
    ...(normalizedBrandColor ? { backgroundColor: [normalizedBrandColor] } : {}),
  }).toDataUri();
}

type CompanyAvatarProps = Omit<ComponentProps<typeof Avatar>, "children"> & {
  companyName: string;
  logoUrl?: string | null;
  brandColor?: string | null;
  logoFit?: "cover" | "contain";
};

export function CompanyAvatar({
  companyName,
  logoUrl,
  brandColor,
  logoFit = "cover",
  className,
  ...props
}: CompanyAvatarProps) {
  const [logoError, setLogoError] = useState(false);
  const logo = !logoError && logoUrl?.trim() ? logoUrl : null;
  const generatedAvatar = useMemo(
    () => createCompanyAvatarDataUri(companyName, brandColor),
    [brandColor, companyName],
  );

  useEffect(() => {
    setLogoError(false);
  }, [logoUrl]);

  return (
    <Avatar className={cn("bg-muted", className)} {...props}>
      <AvatarImage
        key={logo ?? generatedAvatar}
        src={logo ?? generatedAvatar}
        alt={logo ? `${companyName} logo` : ""}
        className={logoFit === "contain" ? "object-contain" : "object-cover"}
        onError={logo ? () => setLogoError(true) : undefined}
      />
      <AvatarFallback>{companyName.trim().charAt(0).toUpperCase() || "?"}</AvatarFallback>
    </Avatar>
  );
}
