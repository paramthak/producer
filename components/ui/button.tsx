import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-[background-color,box-shadow,transform,color] duration-200 transform-gpu focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer active:scale-[0.985]",
  {
    variants: {
      variant: {
        default: "btn-aurora",
        primary: "bg-accent text-accent-foreground shadow-[0_1px_2px_hsl(28_30%_18%_/_0.12),0_8px_20px_-10px_hsl(175_77%_26%_/_0.5)] hover:bg-[hsl(175_70%_22%)]",
        accent: "bg-accent text-accent-foreground hover:bg-[hsl(175_70%_22%)] shadow-[0_8px_20px_-10px_hsl(175_77%_26%_/_0.5)]",
        secondary: "bg-secondary text-secondary-foreground hover:bg-[hsl(39_40%_88%)]",
        outline: "border border-border bg-card hover:bg-secondary",
        ghost: "hover:bg-secondary/70",
        destructive: "bg-destructive text-destructive-foreground hover:bg-[hsl(0_74%_36%)] shadow-[0_8px_20px_-10px_hsl(0_74%_42%_/_0.5)]",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-12 rounded-lg px-6 text-base font-semibold",
        xl: "h-14 rounded-lg px-8 text-base font-semibold",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
