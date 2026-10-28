"""
Bridge between Cypress / External tools and the Core Python Excel Engine.
"""
import sys
import os
import json
import argparse
import yaml

# Ensure project root is in sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.parser import ExcelParser
from core.writer import ExcelWriter

def get_parser_and_config():
    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    config_path = os.path.join(root_dir, "config.yaml")
    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)
    return ExcelParser(config["column_synonyms"]), config

def is_tested_case(tc):
    status = str(tc.get("status") or "").strip().lower()
    return "tested" in status and "not tested" not in status and "untested" not in status and "pending" not in status

def is_rejected_case(tc):
    remark = str(tc.get("remark") or "").strip().lower()
    return "reject" in remark

def sync_tested_status(cases, output_dir, sheet_name):
    """Sync status from all recent run output files in output_dir."""
    import glob, openpyxl
    run_files = sorted(glob.glob(os.path.join(output_dir, "chatbot_test_cases_RUN_*.xlsx")), key=os.path.getmtime, reverse=True)
    if not run_files:
        return cases
    for rf in run_files[:10]:
        try:
            wb = openpyxl.load_workbook(rf, data_only=True)
            if sheet_name in wb.sheetnames:
                ws = wb[sheet_name]
                status_col = None
                result_col = None
                for r in range(1, 10):
                    for c in range(1, ws.max_column + 1):
                        val = str(ws.cell(r, c).value or "").strip().lower()
                        if "test status" in val or val == "status":
                            status_col = c
                        elif "test result" in val or val == "result":
                            result_col = c
                    if status_col:
                        break
                if not status_col:
                    status_col = 12

                for tc in cases:
                    if not is_tested_case(tc):
                        s_col = tc.get("header_map", {}).get("test_status") or status_col
                        r_col = tc.get("header_map", {}).get("test_result") or (s_col + 1 if s_col else 13)
                        st = str(ws.cell(tc["row_idx"], s_col).value or "").strip()
                        if "tested" in st.lower() and "not tested" not in st.lower() and "untested" not in st.lower():
                            tc["status"] = st
                            if r_col:
                                tc["result"] = str(ws.cell(tc["row_idx"], r_col).value or "").strip()
            wb.close()
        except Exception:
            pass
    return cases

def fetch_cases(file_path: str, sheet_name: str, test_id: str = None, limit: int = 0, force: bool = False, start_from: str = None):
    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    parser, config = get_parser_and_config()
    all_cases = parser.parse_sheet(file_path, sheet_name)
    
    # Filter out cases marked as 'reject' in Remark column first
    all_cases = [c for c in all_cases if not is_rejected_case(c)]
    
    # Sync status from latest run output file
    output_dir = os.path.join(root_dir, config["system"]["output_dir"])
    all_cases = sync_tested_status(all_cases, output_dir, sheet_name)

    # Check first: filter out all test cases marked as Tested unless force is requested
    if not force:
        candidate_cases = [c for c in all_cases if not is_tested_case(c)]
    else:
        candidate_cases = all_cases

    # Handle start_from
    if start_from:
        s_target = start_from.strip().lower()
        start_idx = -1
        for idx, c in enumerate(candidate_cases):
            if (s_target == str(c["row_idx"]).lower() or 
                s_target == c["test_id"].lower() or 
                s_target in c["input_raw"].lower() or 
                c["input_raw"].lower() in s_target):
                start_idx = idx
                break
        if start_idx != -1:
            candidate_cases = candidate_cases[start_idx:]

    if test_id:
        target = test_id.strip().lower()
        # Check exact matches first
        exact_all = [c for c in all_cases if c["test_id"].strip().lower() == target]
        if exact_all:
            selected = [c for c in candidate_cases if c["test_id"].strip().lower() == target]
            return selected
        
        # Substring match only if no exact match exists anywhere in the sheet
        selected = [c for c in candidate_cases if target in c["test_id"].strip().lower()]
        return selected

    if limit > 0:
        return candidate_cases[:limit]
    return candidate_cases

def save_result(file_path: str, sheet_name: str, row_idx: int, test_id: str, score: int, result: str, actual_output: str, notes: str, output_file: str = None):
    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    _, config = get_parser_and_config()
    
    # Resolve designated single run output file
    if not output_file:
        output_file = os.environ.get("CURRENT_RUN_OUTPUT_FILE")
    if not output_file:
        session_file = os.path.join(root_dir, ".current_run_output.txt")
        if os.path.exists(session_file):
            try:
                with open(session_file, "r", encoding="utf-8") as f:
                    content = f.read().strip()
                    if content:
                        output_file = content
            except Exception:
                pass

    writer = ExcelWriter(
        original_filepath=file_path,
        output_dir=os.path.join(root_dir, config["system"]["output_dir"]),
        output_filepath=output_file
    )
    
    item = {
        "row_idx": row_idx,
        "test_id": test_id,
        "score": score,
        "result": result,
        "actual_output": actual_output,
        "notes": notes
    }
    out_file = writer.write_results([item], sheet_name=sheet_name, update_original=True)
    return out_file

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", choices=["get", "save"], required=True)
    parser.add_argument("--file", default=None)
    parser.add_argument("--sheet", default="genral user test cases")
    parser.add_argument("--test-id", default=None)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--payload", default=None)
    parser.add_argument("--output-file", default=None, help="Designated run output file")
    parser.add_argument("--force", action="store_true", help="Include already tested cases")
    parser.add_argument("--start-from", default=None, help="Start from specific query, ID, or row")

    args = parser.parse_args()
    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    target_file = args.file or os.path.join(root_dir, "input", "chatbot test cases.xlsx")

    if args.action == "get":
        cases = fetch_cases(target_file, args.sheet, args.test_id, args.limit, force=args.force, start_from=args.start_from)
        print(json.dumps(cases))
    elif args.action == "save":
        payload_str = args.payload
        if not payload_str:
            # Read from stdin safely to prevent command-line quote corruption
            payload_str = sys.stdin.read().strip()

        if payload_str:
            data = json.loads(payload_str)
            out_target = args.output_file or data.get("output_file")
            out = save_result(
                target_file,
                args.sheet,
                data["row_idx"],
                data["test_id"],
                data["score"],
                data["result"],
                data["actual_output"],
                data["notes"],
                output_file=out_target
            )
            print(json.dumps({"success": True, "output_file": out}))
        else:
            print(json.dumps({"success": False, "error": "No payload provided"}))


 
