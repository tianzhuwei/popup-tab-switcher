export interface IWebsiteGroupingState {
  canUndo: boolean;
}

export interface IWebsiteGroupingResult extends IWebsiteGroupingState {
  status:
    | "grouped"
    | "undone"
    | "nothing-to-group"
    | "nothing-to-undo"
    | "permission-denied"
    | "busy"
    | "error";
  groupCount: number;
  error?: string;
}
