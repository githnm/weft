import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { register as registerIntrospect } from "./introspect.js";
import { register as registerVerify } from "./verify.js";
import { register as registerSuggest } from "./suggest.js";
import { register as registerAsk } from "./ask.js";
import { register as registerCorrect } from "./correct.js";
import { register as registerDefine } from "./define.js";
import { register as registerTerms } from "./terms.js";
import { register as registerSession } from "./session.js";
import { register as registerCorrections } from "./corrections.js";
import { register as registerModels } from "./models.js";
import { register as registerInterview } from "./interview.js";
import { register as registerRefine } from "./refine.js";
import { register as registerContext } from "./context.js";

/**
 * Register all MCP tools on the server.
 *
 * 25 tools total, mapped 1:1 to engine functions:
 *   introspect_warehouse, verify_models, refresh_metadata,
 *   suggest_metrics, ask_question, correct_answer, define_term,
 *   list_terms, delete_term, show_session, clear_session,
 *   list_corrections, rollback_correction,
 *   create_model, list_models, show_model, delete_model, list_substrate_tables,
 *   propose_model_plan, build_semantic_model,
 *   refine_model, revert_model_refinement,
 *   get_decision_history, simulate_change, render_context_graph
 */
export function registerAllTools(server: McpServer): void {
  registerIntrospect(server);   // introspect_warehouse
  registerVerify(server);       // verify_models, refresh_metadata
  registerSuggest(server);      // suggest_metrics
  registerAsk(server);          // ask_question
  registerCorrect(server);      // correct_answer
  registerDefine(server);       // define_term, add_definition
  registerTerms(server);        // list_terms, delete_term
  registerSession(server);      // show_session, clear_session
  registerCorrections(server);  // list_corrections, rollback_correction
  registerModels(server);       // create_model, list_models, show_model, delete_model, list_substrate_tables
  registerInterview(server);    // propose_model_plan, build_semantic_model
  registerRefine(server);       // refine_model, revert_model_refinement
  registerContext(server);      // get_decision_history, simulate_change
}
