export interface EventResult<T> {
  status: "ok" | "fail";
  data?: T;
  failMessage?: string;
}
