export interface QuickAccessItem {
  id: string;
  title: string;
  icon: string;
  shortcut?: string;
  run: () => void;
  description?: string;
  searchText?: string;
  prefix?: string;
  preview?: () => void;
}
