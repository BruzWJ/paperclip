import type { ComponentType } from "react";
import type { AnyRoute } from "@tanstack/react-router";

export function getRouteComponent(route: AnyRoute): ComponentType {
  const component = route.options.component;
  if (!component) throw new Error(`Route ${route.id} has no component`);
  return component as ComponentType;
}
