/**
 * Interface representing a failed result (outcome) of an event.
 */
export interface EventFailedResult {
  /**
   * The status of the result.
   */
  status: "fail";

  /**
   * The fail message associated with the result.
   */
  failMessage: string;
}
