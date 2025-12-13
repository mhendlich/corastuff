import type { ButtonHTMLAttributes, PropsWithChildren } from "react";
import classes from "./SelectableRow.module.css";

type SelectableRowProps = PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }>;

export function SelectableRow({ active, className, children, type, ...props }: SelectableRowProps) {
  const merged = [active ? classes.rowActive : classes.row, className].filter(Boolean).join(" ");
  return (
    <button {...props} type={type ?? "button"} className={merged}>
      {children}
    </button>
  );
}
