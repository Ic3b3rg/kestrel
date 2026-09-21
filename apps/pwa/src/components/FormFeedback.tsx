import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "cn";

type FormFeedbackKind = "error" | "pending" | "success";

interface FormFeedbackProps {
  children: ReactNode;
  className?: string;
  focus?: boolean;
  id?: string;
  kind: FormFeedbackKind;
  title?: string;
  visuallyHidden?: boolean;
}

export function FormFeedback({
  children,
  className,
  focus = false,
  id,
  kind,
  title,
  visuallyHidden = false,
}: FormFeedbackProps) {
  const feedback = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focus) feedback.current?.focus();
  }, [focus]);

  return (
    <div
      aria-atomic="true"
      className={cn(
        visuallyHidden
          ? "sr-only"
          : "grid gap-1 border-l p-3 text-sm leading-snug focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        !visuallyHidden && kind === "error" && "border-destructive bg-destructive/10",
        !visuallyHidden && kind === "success" && "border-border bg-muted/50",
        className,
      )}
      data-form-feedback={kind}
      id={id}
      ref={feedback}
      role={kind === "error" ? "alert" : "status"}
      tabIndex={focus ? -1 : undefined}
    >
      {title === undefined ? null : <strong>{title}</strong>}
      <span>{children}</span>
    </div>
  );
}

export function FormFieldError({ children, id }: { children: ReactNode; id: string }) {
  return (
    <p className="m-0 text-xs leading-normal text-destructive" id={id}>
      {children}
    </p>
  );
}
