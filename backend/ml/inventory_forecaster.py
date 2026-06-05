import sys
import os
import csv
import json
from datetime import datetime, date

def calculate_sales_velocity(csv_path):
    """
    Reads sales transactions from CSV and computes average daily sales quantity
    for each medicine.
    """
    sales_by_med = {}
    dates_by_med = {}
    
    with open(csv_path, mode='r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            med_name = row['medicine_name']
            qty = int(row['quantity_sold'])
            tx_date = row['date']
            
            sales_by_med[med_name] = sales_by_med.get(med_name, 0) + qty
            if med_name not in dates_by_med:
                dates_by_med[med_name] = []
            dates_by_med[med_name].append(datetime.strptime(tx_date, "%Y-%m-%d").date())
            
    velocities = {}
    for med_name, total_qty in sales_by_med.items():
        dates = dates_by_med[med_name]
        min_date = min(dates)
        max_date = max(dates)
        
        # Calculate time span in days (minimum 1 day to prevent division by zero)
        days_span = (max_date - min_date).days
        if days_span <= 0:
            days_span = 1
            
        # Daily sales velocity
        velocities[med_name] = total_qty / days_span
        
    return velocities

def main():
    if len(sys.argv) < 3 or sys.argv[1] != '--current_stock':
        print(json.dumps({"error": "Usage: python inventory_forecaster.py --current_stock '[JSON_STRING]'" }))
        sys.exit(1)

    try:
        current_stock = json.loads(sys.argv[2])
    except Exception as e:
        print(json.dumps({"error": f"Failed to parse current stock JSON: {str(e)}"}))
        sys.exit(1)

    # Resolve CSV filepath
    script_dir = os.path.dirname(os.path.abspath(__file__))
    sales_csv_path = os.path.join(script_dir, 'datasets', 'inventory_sales_data.csv')
    
    if not os.path.exists(sales_csv_path):
        print(json.dumps({"error": f"Sales dataset not found at {sales_csv_path}"}))
        sys.exit(1)

    # Calculate velocities
    velocities = calculate_sales_velocity(sales_csv_path)

    recommendations = []
    today = date.today()

    for item in current_stock:
        med_name = item.get('medicine_name')
        qty = int(item.get('quantity', 0))
        reorder_level = int(item.get('reorder_level', 50))
        batch_num = item.get('batch_number', 'All')
        expiry_str = item.get('expiry_date')

        # 1. Fetch sales velocity
        velocity = velocities.get(med_name, 1.5) # Fallback velocity of 1.5 units/day

        # 2. Check stock exhaust timeline (days remaining)
        days_remaining = qty / velocity if velocity > 0 else 999
        
        # 3. Check expiration
        is_expiring = False
        days_to_expiry = 999
        if expiry_str:
            try:
                # Handle ISO timestamps or simple date strings
                clean_expiry_str = expiry_str.split('T')[0]
                expiry_date = datetime.strptime(clean_expiry_str, "%Y-%m-%d").date()
                days_to_expiry = (expiry_date - today).days
                if 0 < days_to_expiry <= 30:
                    is_expiring = True
            except Exception as e:
                pass

        # 4. Replenishment Rules
        warning = ""
        qty_to_order = 0
        priority = "Low"

        if qty == 0:
            warning = "Out of Stock"
            qty_to_order = max(100, reorder_level * 2)
            priority = "High"
        elif is_expiring:
            warning = f"Batch expiring in {days_to_expiry} days (quantity: {qty})"
            qty_to_order = max(100, qty)
            priority = "High" if days_to_expiry <= 10 else "Medium"
        elif qty <= reorder_level:
            warning = f"Low stock alert ({qty} remaining, reorder level {reorder_level})"
            qty_to_order = max(100, reorder_level * 2)
            priority = "Medium"
        elif days_remaining <= 14:
            warning = f"High demand velocity. Current stock exhausts in {int(days_remaining)} days"
            qty_to_order = int(velocity * 30) # order 30 days worth of demand
            priority = "Medium"

        if warning:
            recommendations.append({
                "medicine_name": med_name,
                "batch_number": batch_num,
                "warning_reason": warning,
                "recommended_order_qty": qty_to_order,
                "priority": priority
            })

    # Sort recommendations by priority (High -> Medium -> Low)
    priority_map = {"High": 3, "Medium": 2, "Low": 1}
    recommendations.sort(key=lambda x: priority_map.get(x["priority"], 0), reverse=True)

    # Return top 5 recommendations
    print(json.dumps(recommendations[:5]))

if __name__ == '__main__':
    main()
