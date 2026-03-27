import type { ComponentChildren } from "preact";

export function ActionButton(props: {
  class?: string;
  pending?: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon?: ComponentChildren;
  iconOnly?: boolean;
  label?: string;
  tooltip?: string;
  children?: ComponentChildren;
}) {
  const className = [props.class, "action-btn", props.pending ? "is-pending" : "", props.iconOnly ? "icon-only" : ""]
    .filter(Boolean)
    .join(" ");
  const accessibleLabel =
    props.label ?? (typeof props.children === "string" ? props.children : typeof props.children === "number" ? String(props.children) : undefined);

  return (
    <button class={className} type="button" disabled={props.disabled} aria-busy={props.pending} aria-label={accessibleLabel} onClick={props.onClick}>
      <span class="button-face">
        {props.pending ? <span class="button-spinner" aria-hidden="true"></span> : null}
        {!props.pending && props.icon ? <span class="button-icon">{props.icon}</span> : null}
        {!props.iconOnly ? <span class="button-label">{props.children}</span> : null}
      </span>
      {props.iconOnly && accessibleLabel ? <span class="button-tip" aria-hidden="true">{accessibleLabel}</span> : null}
      {!props.iconOnly && props.tooltip ? <span class="button-tip button-tip-inline" aria-hidden="true">{props.tooltip}</span> : null}
    </button>
  );
}

export function ModalShell(props: {
  open: boolean;
  title: string;
  closeLabel: string;
  className?: string;
  onClose: () => void;
  children: ComponentChildren;
}) {
  return (
    <div class={`overlay ${props.open ? "open" : ""}`} onClick={props.onClose}>
      <div class={`settings-modal dashboard-modal ${props.className ?? ""}`.trim()} onClick={(event) => event.stopPropagation()}>
        <div class="settings-modal-head">
          <div class="settings-modal-title">{props.title}</div>
          <button class="settings-close" type="button" aria-label={props.closeLabel} onClick={props.onClose}>
            ×
          </button>
        </div>
        <div class="settings-modal-body dashboard-modal-body">{props.children}</div>
      </div>
    </div>
  );
}
