import { Neo4jContainer } from '@testcontainers/neo4j';
import type { TestProject } from 'vitest/node';

// One Neo4j container for the whole integration run; test files share it and wipe it
// between tests. Same image as docker-compose.yml.
export const NEO4J_IMAGE = 'neo4j:5.26-community';
const PASSWORD = 'testcontainers-pw';

declare module 'vitest' {
  interface ProvidedContext {
    neo4jUri: string;
    neo4jPassword: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container = await new Neo4jContainer(NEO4J_IMAGE).withPassword(PASSWORD).start();
  project.provide('neo4jUri', container.getBoltUri());
  project.provide('neo4jPassword', PASSWORD);
  return async () => {
    await container.stop();
  };
}
