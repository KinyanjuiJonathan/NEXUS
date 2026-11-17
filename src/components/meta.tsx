import { Briefcase, Folder, Tag, User, Users, Heart, Home, BookOpen, Dumbbell, ShoppingCart, Code } from "lucide-react";
import type { Category, Priority } from "@/data/types";
import type { Urgency } from "@/lib/countdown";

export const PRIORITY_META: Record<Priority, { label: string; color: string; short: string }> = {
  critical: { label: "Critical", color: "#f43f5e", short: "P0" },
  high: { label: "High", color: "#f59e0b", short: "P1" },
  medium: { label: "Medium", color: "#38bdf8", short: "P2" },
  low: { label: "Low", color: "#94a3b8", short: "P3" },
};

export const URGENCY_COLOR: Record<Urgency, string> = {
  overdue: "var(--danger)",
  critical: "var(--warning)",
  soon: "var(--accent)",
  later: "var(--muted)",
  none: "var(--muted)",
};

const ICONS: Record<string, typeof Tag> = {
  briefcase: Briefcase,
  user: User,
  folder: Folder,
  users: Users,
  tag: Tag,
  heart: Heart,
  home: Home,
  book: BookOpen,
  fitness: Dumbbell,
  shopping: ShoppingCart,
  code: Code,
};

export const CATEGORY_ICON_NAMES = Object.keys(ICONS);

export function CategoryIcon({ icon, size = 14 }: { icon: string; size?: number }) {
  const I = ICONS[icon] ?? Tag;
  return <I size={size} />;
}

export function categoryOf(categories: Category[], id: string): Category {
  return categories.find((c) => c.id === id) ?? { id, name: id, color: "#94a3b8", icon: "tag", builtin: false, sortOrder: 99 };
}
