import type { ComponentPropsWithoutRef } from "react";
import type { CardProps } from "@mantine/core";
import { Card } from "@mantine/core";
import classes from "./Panel.module.css";

export type PanelVariant = "default" | "subtle" | "danger";

export function Panel(
  { variant = "default", className, ...props }: CardProps & ComponentPropsWithoutRef<"div"> & { variant?: PanelVariant }
) {
  const variantClass =
    variant === "danger" ? classes.danger : variant === "subtle" ? classes.subtle : classes.panel;

  const merged = [variantClass, className].filter(Boolean).join(" ");

  return <Card withBorder radius="lg" p="lg" className={merged} {...props} />;
}
