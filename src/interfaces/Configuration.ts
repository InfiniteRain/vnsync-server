/**
 * Server configuration interface.
 */
export interface Configuration {
  /**
   * Maximum permitted amount of connections from a single source (ip address).
   */
  maxConnectionsFromSingleSource: number;
}
