/**
 * Server configuration interface.
 */
export interface Configuration {
  /**
   * Maximum permitted amount of connections from a single source (ip address).
   */
  maxConnectionsFromSingleSource: number;

  /**
   * Maximum permitted amount of entries for a host's clipboard history.
   */
  maxClipboardEntries: number;

  /**
   * Maximum amount of time (ms) that a ghost session is allowed to exist.
   */
  ghostSessionLifetime: number;

  /**
   * Interval (ms) at which ghost session cleanup happens.
   */
  ghostSessionCleanupInterval: number;
}
