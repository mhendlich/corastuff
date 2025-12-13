import type { CSSProperties } from "react";
import { Box } from "@mantine/core";
import classes from "./BrandMark.module.css";

export function BrandMark(props: { size?: number }) {
  return (
    <Box
      className={classes.mark}
      style={
        props.size
          ? ({
              "--mark-size": `${props.size}px`
            } as CSSProperties)
          : undefined
      }
    />
  );
}
