export interface RuleFileEntry {
  fullPath: string;
  fileName: string;
}

export interface FolderGroup {
  folderName: string;
  files: RuleFileEntry[];
  isCollapsed: boolean;
}