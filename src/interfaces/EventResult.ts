/**
 * Interface representing a result (outcome) of an event.
 */
export interface EventResult<T> {
  /**
   * The status of the result.
   */
  status: "ok" | "fail";

  /**
   * The data associated with a successful result.
   */
  data?: T;

  /**
   * The fail message associated with a failed result.
   */
  failMessage?: string;
}
