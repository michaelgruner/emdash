import { hierarchyPublicationCases } from "../utils/hierarchy-publication-cases.js";
import { setupTestDatabase, teardownTestDatabase } from "../utils/test-db.js";

hierarchyPublicationCases(setupTestDatabase, teardownTestDatabase);
