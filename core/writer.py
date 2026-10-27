"""
Non-destructive Excel Writer and Report Generator.
Preserves original workbook formatting, styling, and formulas while populating
Test Status, Test result, Score (1-5), Actual Output, and Test Notes in adjacent columns.
"""
import openpyxl
from openpyxl.styles import PatternFill, Font, Alignment
import os
from datetime import datetime
from typing import List, Dict, Any

# Colors for results
FILL_PASS = PatternFill(start_color="D4EDDA", end_color="D4EDDA", fill_type="solid") # light green
FILL_PARTIAL = PatternFill(start_color="FFF3CD", end_color="FFF3CD", fill_type="solid") # light yellow
FILL_FAIL = PatternFill(start_color="F8D7DA", end_color="F8D7DA", fill_type="solid") # light red

FONT_BOLD = Font(bold=True)
ALIGN_CENTER = Alignment(horizontal="center", vertical="center")
ALIGN_LEFT = Alignment(horizontal="left", vertical="top", wrap_text=True)

class ExcelWriter:
    def __init__(self, original_filepath: str, output_dir: str = "output", output_filepath: str = None):
        self.original_filepath = original_filepath
        self.output_dir = output_dir
        os.makedirs(output_dir, exist_ok=True)
        if output_filepath:
            self.run_output_filepath = output_filepath
        else:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            self.run_output_filepath = os.path.join(self.output_dir, f"chatbot_test_cases_RUN_{timestamp}.xlsx")

    def write_results(self, test_results: List[Dict[str, Any]], sheet_name: str, filename_prefix: str = "chatbot_test_cases_EVALUATED", update_original: bool = True) -> str:
        # Load from existing run output file if already created, otherwise load from original
        if os.path.exists(self.run_output_filepath):
            wb = openpyxl.load_workbook(self.run_output_filepath)
        else:
            wb = openpyxl.load_workbook(self.original_filepath)
        if sheet_name in wb.sheetnames:
            ws = wb[sheet_name]
        else:
            ws = wb.active

        # Identify header row and map existing columns
        header_row = 3
        col_map = {}
        for r in range(1, 10):
            found = {}
            for c in range(1, min(ws.max_column + 1, 30)):
                val = str(ws.cell(r, c).value or "").strip().lower()
                if "test status" in val or val == "status":
                    found["status"] = c
                elif "test result" in val or val == "result":
                    found["result"] = c
                elif "actual" in val or "bot response" in val:
                    found["actual"] = c
                elif "score" in val:
                    found["score"] = c
                elif "notes" in val or "ai feedback" in val:
                    found["notes"] = c
            if "status" in found or "result" in found:
                header_row = r
                col_map = found
                break

        # By default, in this sheet:
        # Col 10: Test Status
        # Col 11: Test result
        # We place: Col 12: Actual Output, Col 13: Score (1-5), Col 14: Test Notes / AI Feedback
        status_col = col_map.get("status", 10)
        result_col = col_map.get("result", 11)
        actual_col = col_map.get("actual", 12)
        score_col = col_map.get("score", 13)
        notes_col = col_map.get("notes", 14)

        # Set clean headers if not already set
        ws.cell(header_row, actual_col, "Actual Output").font = FONT_BOLD
        ws.cell(header_row, score_col, "Score (1-10)").font = FONT_BOLD
        ws.cell(header_row, notes_col, "Test Notes / AI Feedback").font = FONT_BOLD

        # Populate evaluated test cases
        for res in test_results:
            r = res["row_idx"]
            score = res.get("score", 1)
            result = str(res.get("result", "FAIL")).upper()
            status = "Tested"
            actual_out = res.get("actual_output", "")
            notes = res.get("notes", "")

            # Set Test Status
            cell_status = ws.cell(r, status_col, status)
            cell_status.alignment = ALIGN_CENTER

            # Set Test Result
            cell_result = ws.cell(r, result_col, result)
            cell_result.alignment = ALIGN_CENTER
            cell_result.font = FONT_BOLD

            # Color coding (1-10 Scale: 8-10 Pass, 5-7 Partial, 1-4 Fail)
            if result == "PASS" or score >= 8:
                cell_result.fill = FILL_PASS
            elif result == "PARTIAL" or score >= 5:
                cell_result.fill = FILL_PARTIAL
            else:
                cell_result.fill = FILL_FAIL

            # Set Actual Output
            cell_actual = ws.cell(r, actual_col, actual_out)
            cell_actual.alignment = ALIGN_LEFT

            # Set Score
            cell_score = ws.cell(r, score_col, score)
            cell_score.alignment = ALIGN_CENTER
            cell_score.font = FONT_BOLD
            if score >= 8:
                cell_score.fill = FILL_PASS
            elif score >= 5:
                cell_score.fill = FILL_PARTIAL
            else:
                cell_score.fill = FILL_FAIL

            # Set Test Notes
            cell_notes = ws.cell(r, notes_col, notes)
            cell_notes.alignment = ALIGN_LEFT

        # Adjust column widths for clean readability
        ws.column_dimensions[openpyxl.utils.get_column_letter(status_col)].width = 14
        ws.column_dimensions[openpyxl.utils.get_column_letter(result_col)].width = 14
        ws.column_dimensions[openpyxl.utils.get_column_letter(actual_col)].width = 45
        ws.column_dimensions[openpyxl.utils.get_column_letter(score_col)].width = 14
        ws.column_dimensions[openpyxl.utils.get_column_letter(notes_col)].width = 50

        # 1. Save to the single designated run output file
        wb.save(self.run_output_filepath)

        # 2. Also update original source file in-place so next runs automatically skip tested cases
        if update_original and os.path.exists(self.original_filepath):
            bak_path = self.original_filepath + ".bak"
            if not os.path.exists(bak_path):
                import shutil
                try:
                    shutil.copy2(self.original_filepath, bak_path)
                except Exception:
                    pass
            try:
                wb.save(self.original_filepath)
            except Exception as e:
                # If file is open in Excel, warn without failing
                pass

        return self.run_output_filepath
