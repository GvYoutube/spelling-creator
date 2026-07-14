// The git engine, behind one dynamic import.
//
// isomorphic-git and LightningFS are ~200 KB that only the editor ever needs —
// nobody reading the homepage or browsing the hub should download a git
// implementation. Everything that touches the object store is re-exported from
// here, and loaded on demand via load.js when the editor mounts.
//
// The pure parts of the version-control layer are NOT here: the document diff
// (ops.js), the merge (merge.js) and the doc helpers (doc.js) have no git
// dependency, so the history and merge dialogs can import them directly and
// still render without the engine present.

// isomorphic-git writes git objects through Node's `Buffer`, which browsers
// don't have — without this, the first writeBlob dies with "Buffer is not
// defined".
//
// Deliberately done here rather than with rspack's ProvidePlugin: ProvidePlugin
// injects the polyfill into *every* module that so much as mentions `Buffer`,
// which in this app means docx, mammoth and html2pdf as well — pulling the
// polyfill into the main bundle and, worse, potentially flipping those libraries
// onto their Node code paths. Setting the global inside this chunk keeps the
// polyfill where it's needed and leaves every other module exactly as it was.
import { Buffer } from "buffer";

if (typeof globalThis.Buffer === "undefined") globalThis.Buffer = Buffer;

export {
  DRAFT_REPO,
  adoptDraftRepo,
  copyRepo,
  deleteRepo,
  gitFs,
  repoCtx,
  repoExists,
} from "./fs.js";

export {
  BLOCK_DIR,
  MANIFEST_PATH,
  readBlockOids,
  readDocTree,
  readManifest,
  writeDocTree,
} from "./layout.js";

export {
  BRANCH,
  BRANCH_REF,
  ORIGIN_REF,
  UPSTREAM_REF,
  authorFrom,
  changedBlockIds,
  commitDoc,
  diffCommits,
  diffFromParent,
  ensureRepo,
  headOid,
  history,
  pendingOps,
  readDocAt,
  readHeadDoc,
  restoreCommit,
  treeOfCommit,
} from "./repo.js";

export {
  cloneFromPack,
  contains,
  fetchRemotePack,
  mergeBase,
  packRepo,
  reachableOids,
} from "./pack.js";

export {
  completeMerge,
  forkLessonRepo,
  forkLocalRepo,
  prepareMerge,
  pushHistory,
  pushToUpstream,
  remoteStatus,
} from "./sync.js";
