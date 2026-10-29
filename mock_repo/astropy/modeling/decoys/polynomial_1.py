class PolynomialModel:
    def __init__(self, degree):
        self.degree = degree
    def evaluate(self, x):
        return sum(x**i for i in range(self.degree))
