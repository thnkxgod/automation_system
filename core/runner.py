"""
Chatbot API Test Runner.
Executes single-turn and multi-turn conversations against the live chatbot API.
"""
import urllib.request
import json
import uuid
import time
import random
import logging
from typing import Dict, Any, List, Tuple

logger = logging.getLogger(__name__)

class ChatbotRunner:
    def __init__(self, endpoint: str, origin: str, referer: str, timeout: int = 120, retries: int = 1, retry_delay: int = 5):
        self.endpoint = endpoint
        self.origin = origin
        self.referer = referer
        self.timeout = timeout
        self.retries = retries
        self.retry_delay = retry_delay

    def clear_session(self) -> Tuple[str, str]:
        """
        Creates a clean, isolated session state for a new test scenario.
        Returns (fresh_session_uuid, fresh_user_id).
        """
        fresh_uuid = str(uuid.uuid4())
        # Generate unique numeric user ID to prevent server-side chat history crossover
        fresh_user_id = str(int(time.time() * 100) % 100000000 + random.randint(1000, 99999))
        return fresh_uuid, fresh_user_id

    def send_single_query(self, query: str, user_id: str, session_uuid: str) -> Dict[str, Any]:
        payload = {
            "user_id": str(user_id),
            "uuid": str(session_uuid),
            "query": query
        }
        data = json.dumps(payload).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Origin": self.origin,
            "Referer": self.referer,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) QA-Automation-Runner"
        }

        req = urllib.request.Request(self.endpoint, data=data, headers=headers)

        last_error = None
        is_timeout = False
        last_elapsed = 0.0

        for attempt in range(1, self.retries + 2):
            t0 = time.time()
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    elapsed = time.time() - t0
                    res_body = json.loads(resp.read().decode("utf-8"))
                    answer = res_body.get("data", {}).get("answer") or ""
                    return {
                        "success": True,
                        "status_code": resp.status,
                        "answer": answer.strip(),
                        "elapsed_seconds": round(elapsed, 2),
                        "raw_response": res_body,
                        "error_reason": None
                    }
            except Exception as e:
                elapsed = time.time() - t0
                last_elapsed = elapsed
                err_lower = str(e).lower()
                if "timed out" in err_lower or "timeout" in err_lower:
                    is_timeout = True
                    last_error = f"Timed Out: No response received within {self.timeout}s (2-minute limit reached)"
                elif "502" in err_lower:
                    is_timeout = False
                    last_error = "HTTP 502 Bad Gateway: Backend server crashed or gateway timed out"
                elif "500" in err_lower:
                    is_timeout = False
                    last_error = "HTTP 500 Internal Server Error"
                else:
                    is_timeout = False
                    last_error = f"Connection Error: {e}"

                if attempt <= self.retries:
                    time.sleep(self.retry_delay)

        # Formulate clear failure reason for sheet
        if is_timeout:
            answer_tag = f"[TIMEOUT: No response received within {self.timeout}s]"
        else:
            answer_tag = f"[ERROR: {last_error}]"

        return {
            "success": False,
            "status_code": 408 if is_timeout else 0,
            "answer": answer_tag,
            "elapsed_seconds": round(last_elapsed, 2),
            "raw_response": None,
            "error_reason": last_error
        }

    def execute_test_case(self, test_case: Dict[str, Any]) -> Dict[str, Any]:
        """
        Executes all turns in a test case with a freshly cleared session.
        Waits for previous turn response completely before attempting next.
        """
        session_uuid, user_id = self.clear_session()
        turns = test_case.get("turns", [""])
        
        turn_results = []
        final_answer = ""
        total_time = 0.0
        aborted_reason = None

        for turn_idx, query in enumerate(turns):
            if not query:
                continue
            res = self.send_single_query(query=query, user_id=user_id, session_uuid=session_uuid)
            turn_results.append({
                "turn": turn_idx + 1,
                "query": query,
                "answer": res["answer"],
                "success": res["success"],
                "elapsed": res["elapsed_seconds"],
                "error_reason": res.get("error_reason")
            })
            final_answer = res["answer"]
            total_time += res["elapsed_seconds"]

            # If this turn failed or timed out, stop further turns for this scenario
            if not res["success"]:
                aborted_reason = res.get("error_reason")
                break

            # If multi-turn and succeeded, add brief pause before next turn
            if len(turns) > 1 and turn_idx < len(turns) - 1:
                time.sleep(2.0)

        # In multi-turn scenarios, summarize conversation in final answer
        if len(turn_results) > 1:
            dialogue_summary = []
            for tr in turn_results:
                dialogue_summary.append(f"Turn {tr['turn']} User: {tr['query']}")
                dialogue_summary.append(f"Turn {tr['turn']} Bot: {tr['answer']}")
            combined_display = "\n".join(dialogue_summary)
        else:
            combined_display = final_answer

        return {
            "test_id": test_case.get("test_id"),
            "session_uuid": session_uuid,
            "user_id": user_id,
            "turn_results": turn_results,
            "final_answer": final_answer,
            "display_answer": combined_display,
            "total_elapsed": round(total_time, 2),
            "all_succeeded": all(tr["success"] for tr in turn_results),
            "error_reason": aborted_reason
        }

