def add(a, b):
    """
    Add two numbers and return their sum.

    Args:
        a: First numeric value
        b: Second numeric value

    Returns:
        The sum of a and b
    """
    return a + b


if __name__ == "__main__":
    # Demonstrate the add function with example inputs
    num1 = 5
    num2 = 3
    result = add(num1, num2)
    print(f"{num1} + {num2} = {result}")

    # Additional examples
    print(f"10 + 20 = {add(10, 20)}")
    print(f"3.5 + 2.5 = {add(3.5, 2.5)}")
    print(f"-5 + 15 = {add(-5, 15)}")
