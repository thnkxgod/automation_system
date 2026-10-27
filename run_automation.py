"""
Master Automation Test Suite Entrypoint.
Orchestrates Excel ingestion, live Chatbot API execution, Groq AI Judge evaluation, and Excel report generation.
Evaluates test cases sequentially one-by-one with real-time progress, status filtering, and targeted test ID testing.
"""
import os
import sys
import argparse
import time
from datetime import datetime
import yaml
from dotenv import load_dotenv

# Ensure utf-8 output on Windows console
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

# Ensure local modules are accessible
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from core.parser import ExcelParser
from core.runner import ChatbotRunner
from core.judge import GroqJudge
from core.writer import ExcelWriter

def load_environment_and_config():
    load_dotenv()
    config_path = os.path.join(os.path.dirname(__file__), "config.yaml")
    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)

    groq_api_key = os.getenv("GROQ_API_KEY")
    if not groq_api_key:
        print("ERROR: GROQ_API_KEY not found in .env file. Please check .env.", flush=True)
        sys.exit(1)

    return config, groq_api_key

def check_quit_requested() -> bool:
    """Non-blocking check for user pressing 'q' / 'Q' / Esc to quit early on Windows console."""
    if sys.platform == "win32":
        try:
            import msvcrt
            while msvcrt.kbhit():
                ch = msvcrt.getch()
                if ch in [b'q', b'Q', b'\x03', b'\x1b']:
                    return True
        except Exception:
            pass
    return False

def is_tested_case(tc: dict) -> bool:
    """Check if test case has already been marked as Tested."""
    status = str(tc.get("status") or "").strip().lower()
    return "tested" in status and "not tested" not in status and "untested" not in status

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
                for tc in cases:
                    if not is_tested_case(tc):
                        st = str(ws.cell(tc["row_idx"], 10).value or "").strip()
                        if "tested" in st.lower() and "not tested" not in st.lower() and "untested" not in st.lower():
                            tc["status"] = st
                            tc["result"] = str(ws.cell(tc["row_idx"], 11).value or "").strip()
            wb.close()
        except Exception:
            pass
    return cases

def interruptible_delay(seconds: float) -> bool:
    """Sleeps for given seconds checking for 'q' every 100ms. Returns True if quit requested."""
    interval = 0.1
    elapsed = 0.0
    while elapsed < seconds:
        if check_quit_requested():
            return True
        time.sleep(min(interval, max(0.0, seconds - elapsed)))
        elapsed += interval
    return False

def main():
    parser = argparse.ArgumentParser(description="Automated Chatbot Testing & Evaluation Engine")
    parser.add_argument("--file", type=str, default=None, help="Name or path of Excel file in input/ folder")
    parser.add_argument("--sheet", type=str, default=None, help="Sheet name to test")
    parser.add_argument("--test-id", type=str, default=None, help="Run a specific single test case by Test ID (e.g. 1, 12, HR-001, MS-005)")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of test cases to run")
    parser.add_argument("--offset", type=int, default=0, help="Offset to start from in parsed test cases")
    parser.add_argument("--pilot", action="store_true", help="Run the first 10 pilot cases")
    parser.add_argument("--force", action="store_true", help="Re-run and re-evaluate test cases even if already marked as 'Tested'")
    parser.add_argument("--ui", action="store_true", help="Launch Cypress browser window to watch test scenarios execute live on screen")
    parser.add_argument("--open", action="store_true", help="Open the full interactive Cypress Desktop Application GUI")
    parser.add_argument("--output", type=str, default=None, help="Designated single output Excel file for this run")
    parser.add_argument("--start-from", type=str, default=None, help="Start testing from a specific query, test ID, or row number (e.g. --start-from 'Which industries do you work with?' or --start-from 35)")
    parser.add_argument("--delay", type=float, default=2.0, help="Delay in seconds between test cases (default: 2.0s)")

    args = parser.parse_args()
    config, groq_api_key = load_environment_and_config()

    # Determine designated single output file for this entire run
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = config["system"]["output_dir"]
    os.makedirs(output_dir, exist_ok=True)
    if args.output:
        run_output_path = args.output if os.path.isabs(args.output) else os.path.join(output_dir, args.output)
    else:
        run_output_path = os.path.join(output_dir, f"chatbot_test_cases_RUN_{timestamp}.xlsx")

    # Persist run output file path for sub-processes (Cypress, bridge, etc.)
    os.environ["CURRENT_RUN_OUTPUT_FILE"] = run_output_path
    try:
        with open(".current_run_output.txt", "w", encoding="utf-8") as f:
            f.write(run_output_path)
    except Exception:
        pass

    # Determine input file path
    input_filename = args.file or config["system"]["default_file"]
    if not os.path.isabs(input_filename):
        input_path = os.path.join(config["system"]["input_dir"], input_filename)
        if not os.path.exists(input_path):
            input_path = input_filename
    else:
        input_path = input_filename

    if not os.path.exists(input_path):
        print(f"ERROR: Excel file not found at: {input_path}", flush=True)
        sys.exit(1)

    sheet_name = args.sheet or config["system"]["default_sheet"]

    # If --open or --ui flag is supplied, delegate execution to Cypress
    if args.ui or args.open:
        # Check first if target cases are already marked as Tested
        if not args.force:
            pre_parser = ExcelParser(config["column_synonyms"])
            all_pre_cases = pre_parser.parse_sheet(input_path, sheet_name)
            all_pre_cases = sync_tested_status(all_pre_cases, config["system"]["output_dir"], sheet_name)
            if args.test_id:
                t_id = args.test_id.strip().lower()
                matched = [c for c in all_pre_cases if c["test_id"].strip().lower() == t_id]
                if not matched:
                    matched = [c for c in all_pre_cases if t_id in c["test_id"].strip().lower()]
                if matched and all(is_tested_case(c) for c in matched):
                    print("=" * 75, flush=True)
                    print(f"⏭️  [STATUS CHECK] Test ID '{args.test_id}' (Row {matched[0]['row_idx']}) is ALREADY marked as 'Tested'!", flush=True)
                    print(f"   Skipping. (Pass --force if you want to re-run in UI mode).", flush=True)
                    print("=" * 75, flush=True)
                    sys.exit(0)
            else:
                untested_pre = [c for c in all_pre_cases if not is_tested_case(c)]
                if not untested_pre:
                    print("=" * 75, flush=True)
                    print(f"🎉 [STATUS CHECK] All {len(all_pre_cases)} test cases in '{sheet_name}' are ALREADY marked as 'Tested'!", flush=True)
                    print(f"   Nothing to run. (Pass --force to re-test in UI mode).", flush=True)
                    print("=" * 75, flush=True)
                    sys.exit(0)

        cypress_bin = os.path.join("node_modules", ".bin", "cypress.cmd")
        cypress_exec = cypress_bin if os.path.exists(cypress_bin) else "npx cypress"

        if args.open:
            print("=" * 75, flush=True)
            print("[CYPRESS GUI] Opening Interactive Cypress Test Runner Window...", flush=True)
            print("=" * 75, flush=True)
            cmd = [cypress_exec, "open"]
        else:
            print("=" * 75, flush=True)
            print("[UI MODE] Launching Cypress browser window to execute test scenario visually...", flush=True)
            if args.test_id:
                print(f"[TARGET] Single Test ID: {args.test_id}", flush=True)
            if args.start_from:
                print(f"[START] From Scenario : {args.start_from}", flush=True)
            print(f"[OUTPUT] Single Run File: {run_output_path}", flush=True)
            print("=" * 75, flush=True)
            cmd = [cypress_exec, "run", "--headed", "--no-exit", "--spec", "cypress/e2e/chatbot_excel_scenarios.cy.js"]

        env_opts = []
        if args.test_id:
            env_opts.append(f"testId={args.test_id.strip()}")
        if args.sheet:
            env_opts.append(f"sheet={args.sheet.strip()}")
        if args.force:
            env_opts.append("force=true")
        if args.start_from:
            env_opts.append(f"startFrom={args.start_from.strip()}")
        if args.pilot:
            env_opts.append("limit=10")
        elif args.limit:
            env_opts.append(f"limit={args.limit}")

        if env_opts and not args.open:
            cmd.extend(["--env", ",".join(env_opts)])

        import subprocess
        child_env = os.environ.copy()
        child_env["CURRENT_RUN_OUTPUT_FILE"] = run_output_path
        if "ELECTRON_RUN_AS_NODE" in child_env:
            del child_env["ELECTRON_RUN_AS_NODE"]
        
        full_cmd = " ".join(cmd)
        if sys.platform == "win32":
            full_cmd = f'cmd /c "set ELECTRON_RUN_AS_NODE=&& {full_cmd}"'

        print(f"[CMD] {full_cmd}\n", flush=True)
        result = subprocess.run(full_cmd, shell=True, env=child_env)
        sys.exit(result.returncode)

    print("=" * 75, flush=True)
    print("[START] AUTOMATED CHATBOT TESTING & EVALUATION SYSTEM", flush=True)
    print(f"[FILE] Target File   : {input_path}", flush=True)
    print(f"[SHEET] Sheet Name   : {sheet_name}", flush=True)
    print(f"[API] Chatbot API    : {config['api']['chat_endpoint']}", flush=True)
    print(f"[MODEL] Groq Judge   : {config['groq']['model']}", flush=True)
    print("=" * 75, flush=True)

    # 1. Parse Excel and sync latest evaluated status
    excel_parser = ExcelParser(config["column_synonyms"])
    all_cases = excel_parser.parse_sheet(input_path, sheet_name)
    all_cases = sync_tested_status(all_cases, config["system"]["output_dir"], sheet_name)
    total_found = len(all_cases)
    print(f"\n[OK] Total test cases detected in sheet: {total_found}", flush=True)

    # 2. Filter test cases
    if args.test_id:
        target_id = args.test_id.strip().lower()
        exact_matches = [tc for tc in all_cases if tc["test_id"].strip().lower() == target_id]
        if exact_matches:
            matched_cases = exact_matches
        else:
            matched_cases = [tc for tc in all_cases if target_id in tc["test_id"].strip().lower()]
        
        if not matched_cases:
            print(f"❌ ERROR: Test ID '{args.test_id}' not found in sheet '{sheet_name}'.", flush=True)
            print("   Available IDs sample:", [tc["test_id"] for tc in all_cases[:15]], flush=True)
            sys.exit(1)

        # Check first if already tested
        if not args.force:
            selected_cases = [tc for tc in matched_cases if not is_tested_case(tc)]
            if not selected_cases:
                print("=" * 75, flush=True)
                print(f"⏭️  [STATUS CHECK] Test ID '{args.test_id}' (Row {matched_cases[0]['row_idx']}) is ALREADY marked as 'Tested'!", flush=True)
                print(f"   Skipping. (Pass --force to re-test this case).", flush=True)
                print("=" * 75, flush=True)
                sys.exit(0)
            elif len(selected_cases) < len(matched_cases):
                skipped_cnt = len(matched_cases) - len(selected_cases)
                print(f"⏭️  [STATUS CHECK] Skipped {skipped_cnt} scenario(s) of Test ID '{args.test_id}' that were already marked as 'Tested'.", flush=True)
        else:
            selected_cases = matched_cases
            print(f"🔄 [FORCE MODE] Re-evaluating Test ID '{args.test_id}' ({len(matched_cases)} scenario(s)) even though already tested.", flush=True)

        print(f"🎯 Single Test Case Targeted: Test ID '{selected_cases[0]['test_id']}' (Row {selected_cases[0]['row_idx']})", flush=True)

    else:
        # Check Test Status: filter out all test cases marked as 'Tested' unless --force
        if not args.force:
            untested_cases = [tc for tc in all_cases if not is_tested_case(tc)]
            skipped_count = total_found - len(untested_cases)
            if skipped_count > 0:
                print(f"⏭️  [STATUS CHECK] Skipped {skipped_count} test cases already marked as 'Tested'.", flush=True)
                print(f"   Remaining pending cases to evaluate: {len(untested_cases)} (Use --force to re-test all)", flush=True)
            candidate_pool = untested_cases
        else:
            print("🔄 [FORCE MODE] Re-evaluating all cases including previously tested ones.", flush=True)
            candidate_pool = all_cases

        if not candidate_pool:
            print("=" * 75, flush=True)
            print("🎉 [STATUS CHECK] All test cases in this sheet are already marked as 'Tested'! Nothing to run.", flush=True)
            print("   (Pass --force to re-run and re-score them if desired.)", flush=True)
            print("=" * 75, flush=True)
            sys.exit(0)

        # Handle --start-from if provided
        if args.start_from:
            s_target = args.start_from.strip().lower()
            start_idx = -1
            for idx, c in enumerate(candidate_pool):
                if (s_target == str(c["row_idx"]).lower() or 
                    s_target == c["test_id"].lower() or 
                    s_target in c["input_raw"].lower() or 
                    c["input_raw"].lower() in s_target):
                    start_idx = idx
                    break
            if start_idx != -1:
                print(f"🎯 [START-FROM] Starting test suite from Row {candidate_pool[start_idx]['row_idx']} (Test ID {candidate_pool[start_idx]['test_id']}): \"{candidate_pool[start_idx]['input_raw'][:60]}\"", flush=True)
                candidate_pool = candidate_pool[start_idx:]
            else:
                print(f"⚠️  [START-FROM] Query or ID '{args.start_from}' not found among untested cases. Starting from top pending case.", flush=True)
            print("🎉 [STATUS CHECK] All test cases in this sheet are already marked as 'Tested'! Nothing to run.", flush=True)
            print("   (Pass --force to re-run and re-score them if desired.)", flush=True)
            print("=" * 75, flush=True)
            sys.exit(0)

        # Apply pilot or limit
        if args.pilot:
            selected_cases = candidate_pool[:10]
            print(f"🎯 Pilot Mode Enabled: Running {len(selected_cases)} scenarios one-by-one.", flush=True)
        elif args.limit:
            selected_cases = candidate_pool[args.offset : args.offset + args.limit]
            print(f"🎯 Sliced Mode: Running {len(selected_cases)} scenarios (offset={args.offset}) one-by-one.", flush=True)
        else:
            selected_cases = candidate_pool[args.offset :]
            print(f"🚀 Running {len(selected_cases)} pending test cases one-by-one!", flush=True)

    # 3. Initialize Runner, Judge, and Writer
    runner = ChatbotRunner(
        endpoint=config["api"]["chat_endpoint"],
        origin=config["api"]["origin"],
        referer=config["api"]["referer"],
        timeout=config["api"]["timeout_seconds"],
        retries=config["api"]["max_retries"],
        retry_delay=config["api"]["retry_delay_seconds"]
    )

    judge = GroqJudge(
        api_key=groq_api_key,
        primary_model=config["groq"]["model"],
        fallback_model=config["groq"]["fallback_model"],
        temperature=config["groq"]["temperature"],
        max_tokens=config["groq"]["max_tokens"]
    )

    writer = ExcelWriter(
        original_filepath=input_path,
        output_dir=config["system"]["output_dir"],
        output_filepath=run_output_path
    )

    # 4. Execute and Evaluate Case by Case
    evaluated_results = []
    print("\n" + "-" * 75, flush=True)
    print(f"[WAIT] Starting Evaluation of {len(selected_cases)} Test Cases (1-by-1)...", flush=True)
    print(f"[INFO] Single Run Output File : {run_output_path}", flush=True)
    print(f"💡 CONTROLS: Press 'q' or Ctrl+C at any time to QUIT early and save all tested entries.", flush=True)
    print("-" * 75, flush=True)

    score_counts = {i: 0 for i in range(1, 11)}
    verdict_counts = {"PASS": 0, "PARTIAL": 0, "FAIL": 0}

    start_total_time = time.time()
    quit_requested = False

    try:
        for idx, tc in enumerate(selected_cases, 1):
            if check_quit_requested():
                quit_requested = True
                print("\n🛑 [QUIT] 'q' key detected. Stopping test suite gracefully...", flush=True)
                break

            print(f"\n▶ [{idx}/{len(selected_cases)}] Test ID: {tc['test_id']} (Excel Row {tc['row_idx']})", flush=True)
            print(f"   Feature   : {tc['feature']}", flush=True)
            print(f"   Query     : {tc['input_raw'][:75]}", flush=True)
            print(f"   Expected  : {tc['expected'][:75]}", flush=True)

            # Execute conversation against live API
            t0 = time.time()
            exec_res = runner.execute_test_case(tc)
            run_elapsed = round(time.time() - t0, 2)
            print(f"   Bot Reply : {exec_res['final_answer'][:80]}... ({run_elapsed}s)", flush=True)

            # Evaluate with Groq Judge
            eval_res = judge.evaluate(tc, exec_res["display_answer"])
            score = eval_res["score"]
            result = eval_res["result"]
            notes = eval_res["notes"]

            score_counts[score] = score_counts.get(score, 0) + 1
            verdict_counts[result] = verdict_counts.get(result, 0) + 1

            color_tag = "[PASS]" if result == "PASS" else ("[PARTIAL]" if result == "PARTIAL" else "[FAIL]")
            print(f"   Verdict   : {color_tag} {result} | Score: {score}/10", flush=True)
            print(f"   AI Notes  : {notes}", flush=True)

            evaluated_results.append({
                "row_idx": tc["row_idx"],
                "test_id": tc["test_id"],
                "score": score,
                "result": result,
                "actual_output": exec_res["display_answer"],
                "notes": notes,
                "elapsed_seconds": run_elapsed
            })

            # Save immediately to the single run file so tested cases are persisted in real time
            writer.write_results(
                evaluated_results,
                sheet_name=sheet_name,
                update_original=True
            )

            # Check for quit key during inter-test delay
            if idx < len(selected_cases):
                if interruptible_delay(args.delay):
                    quit_requested = True
                    print("\n🛑 [QUIT] 'q' key pressed during delay. Stopping test suite gracefully...", flush=True)
                    break

    except KeyboardInterrupt:
        quit_requested = True
        print("\n🛑 [QUIT] User interrupted with Ctrl+C. Stopping test suite gracefully...", flush=True)

    total_duration = round(time.time() - start_total_time, 2)

    # 5. Final Write to Excel
    if evaluated_results:
        final_out_file = writer.write_results(
            evaluated_results,
            sheet_name=sheet_name,
            update_original=True
        )

        print("\n" + "=" * 75, flush=True)
        if quit_requested:
            print(f"🛑 [QUIT COMPLETED] Automation stopped early by user request.", flush=True)
            print(f"   Saved all {len(evaluated_results)} test cases tested so far into single run file!", flush=True)
        else:
            print(f"🎉 [COMPLETE] All {len(evaluated_results)} test cases evaluated successfully!", flush=True)
        print("=" * 75, flush=True)
        print(f"📁 Output Excel File   : {final_out_file}", flush=True)
        print(f"📊 Scenarios Evaluated : {len(evaluated_results)} / {len(selected_cases)}", flush=True)
        print(f"⏱️  Execution Time      : {total_duration}s", flush=True)
        print(f"Verdicts Breakdown     : PASS={verdict_counts['PASS']}, PARTIAL={verdict_counts['PARTIAL']}, FAIL={verdict_counts['FAIL']}", flush=True)
        print(f"Score Distribution     : 10*={score_counts[10]}, 9*={score_counts[9]}, 8*={score_counts[8]}, 7*={score_counts[7]}, 6*={score_counts[6]}, 5*={score_counts[5]}, 4*={score_counts[4]}, 3*={score_counts[3]}, 2*={score_counts[2]}, 1*={score_counts[1]}", flush=True)
        print("=" * 75 + "\n", flush=True)
    else:
        print("\n[INFO] No test cases evaluated before quitting.", flush=True)
    print("=" * 75, flush=True)

if __name__ == "__main__":
    main()
