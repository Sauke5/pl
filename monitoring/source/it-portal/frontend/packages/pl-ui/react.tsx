import {
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import "./core.js";

export type Branding = { name?: string; subtitle?: string; label?: string };
type User = { name?: string; subtitle?: string };
type Slot =
  | "navigation"
  | "sidebarFooter"
  | "breadcrumb"
  | "actions"
  | "main"
  | "banner"
  | "footer"
  | "overlays";
type Controller = {
  element: HTMLElement;
  slots: Record<Slot, HTMLElement>;
  setUser(user: User): void;
  setContext(context: string): void;
  setLogoutDisabled(value: boolean): void;
  destroy(): void;
};
declare global {
  interface Window {
    PLUI: {
      version: number;
      createShell(options: {
        branding?: Branding;
        sidebar?: boolean;
        wide?: boolean;
        platformHref?: string;
        user?: User;
        context?: string;
        onPlatformNavigate?: (event: MouseEvent) => void;
        onLogout?: (event: MouseEvent) => void | Promise<void>;
        onCollapsedChange?: (collapsed: boolean) => void;
      }): Controller;
      createBrand(options?: {
        branding?: Branding;
        platformHref?: string;
        onPlatformNavigate?: (event: MouseEvent) => void;
      }): HTMLElement;
      buttonClasses(options: {
        variant?: string;
        size?: string;
        className?: string;
      }): string;
      sidebar: {
        get(): boolean;
        set(value: boolean): void;
        subscribe(listener: (value: boolean) => void): () => void;
      };
    };
  }
}

export type ShellProps = {
  children: ReactNode;
  branding?: Branding;
  context: string;
  user?: User;
  navigation?: ReactNode;
  sidebarFooter?: ReactNode;
  actions?: ReactNode;
  breadcrumbExtra?: ReactNode;
  banner?: ReactNode;
  footer?: ReactNode;
  overlays?: ReactNode;
  sidebar?: boolean;
  wide?: boolean;
  initialCollapsed?: boolean;
  platformHref?: string;
  onPlatformNavigate?: (event: MouseEvent) => void;
  onLogout?: (event: MouseEvent) => void | Promise<void>;
  onCollapsedChange?: (collapsed: boolean) => void;
  mainClassName?: string;
  shellClassName?: string;
  logoutDisabled?: boolean;
};

/** React owns only the contents of the outlets; the common DOM core owns the shell. */
export function PlatformShell(props: ShellProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const [shell, setShell] = useState<Controller>();
  const hasSidebar = props.sidebar !== false;
  const wide = !!props.wide;
  const hasLogout = !!props.onLogout;
  const platformHref = props.platformHref || "/";
  useLayoutEffect(() => {
    if (!host.current) return;
    // Preserve the account's existing preference on the first visit, then use
    // the same browser preference as the other applications.
    try {
      if (
        localStorage.getItem("pl-ui-sidebar-collapsed") === null &&
        latest.current.initialCollapsed !== undefined
      ) {
        window.PLUI.sidebar.set(latest.current.initialCollapsed);
      }
    } catch {
      if (latest.current.initialCollapsed !== undefined)
        window.PLUI.sidebar.set(latest.current.initialCollapsed);
    }
    const controller = window.PLUI.createShell({
      branding: latest.current.branding,
      sidebar: hasSidebar,
      wide,
      platformHref,
      user: latest.current.user,
      context: latest.current.context,
      onPlatformNavigate: (event) => latest.current.onPlatformNavigate?.(event),
      onLogout: latest.current.onLogout
        ? (event) => latest.current.onLogout?.(event)
        : undefined,
      onCollapsedChange: (value) => latest.current.onCollapsedChange?.(value),
    });
    controller.slots.main.id = "main-content";
    if (latest.current.shellClassName)
      controller.element.classList.add(
        ...latest.current.shellClassName.split(/\s+/).filter(Boolean),
      );
    host.current.append(controller.element);
    setShell(controller);
    return () => {
      controller.destroy();
      controller.element.remove();
    };
  }, [hasSidebar, platformHref, hasLogout, props.branding?.name, props.branding?.subtitle, props.branding?.label]);
  useLayoutEffect(() => {
    shell?.element.classList.toggle("pl-ui-shell-wide", wide);
  }, [shell, wide]);
  useLayoutEffect(() => {
    shell?.setUser(props.user || {});
  }, [shell, props.user?.name, props.user?.subtitle]);
  useLayoutEffect(() => {
    shell?.setContext(props.context);
  }, [shell, props.context]);
  useLayoutEffect(() => {
    shell?.setLogoutDisabled(!!props.logoutDisabled);
  }, [shell, props.logoutDisabled]);
  useLayoutEffect(() => {
    if (props.initialCollapsed === undefined) return;
    try {
      if (localStorage.getItem("pl-ui-sidebar-collapsed") === null)
        window.PLUI.sidebar.set(props.initialCollapsed);
    } catch {
      window.PLUI.sidebar.set(props.initialCollapsed);
    }
  }, [props.initialCollapsed]);
  useLayoutEffect(() => {
    if (shell)
      shell.slots.main.className = `pl-ui-main ${props.mainClassName || ""}`;
  }, [shell, props.mainClassName]);
  return (
    <div ref={host} className="pl-ui-shell-host">
      {shell && (
        <>
          {createPortal(props.navigation, shell.slots.navigation)}
          {createPortal(props.sidebarFooter, shell.slots.sidebarFooter)}
          {createPortal(props.actions, shell.slots.actions)}
          {props.breadcrumbExtra &&
            createPortal(props.breadcrumbExtra, shell.slots.breadcrumb)}
          {createPortal(props.banner, shell.slots.banner)}
          {createPortal(props.children, shell.slots.main)}
          {createPortal(props.footer, shell.slots.footer)}
          {createPortal(props.overlays, shell.slots.overlays)}
        </>
      )}
    </div>
  );
}

export function Brand({ branding }: { branding?: Branding } = {}) {
  const host = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = window.PLUI.createBrand({ branding });
    host.current?.append(element);
    return () => element.remove();
  }, [branding?.name, branding?.subtitle, branding?.label]);
  return <span ref={host} className="pl-ui-brand-host" />;
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: React.Ref<HTMLButtonElement>;
  variant?: "default" | "secondary" | "ghost" | "destructive";
  size?: "default" | "sm" | "icon";
};
export function Button({
  variant = "secondary",
  size = "default",
  type = "button",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={window.PLUI.buttonClasses({ variant, size, className })}
    />
  );
}
